import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Copy, ExternalLink, FileText, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { deletePageAction } from "@/actions/pages";
import type { PageListItem } from "@/lib/api";
import { pageCollection } from "@/collections/pages";
import { AppShell } from "@/components/AppShell";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SidebarTrigger } from "@/components/ui/sidebar";

import { requireAuth, useRequireAuth } from "./-guards";

import "./-dashboard.css";

export const Route = createFileRoute("/dashboard")({
  beforeLoad: ({ location }) => requireAuth(location.href),
  component: DashboardPage,
  ssr: false,
});

/**
 * Port of app/src/routes/dashboard.vue (requiresAuth).
 * Canonical collection+actions: useLiveQuery(pageCollection) for the list,
 * deletePageAction().when("settled") for optimistic deletes.
 */
function DashboardPage() {
  const router = useRouter();
  useRequireAuth();

  const pagesQuery = useLiveQuery((q) => q.from({ page: pageCollection }));
  // Same row assumption as dashboard.vue + CommandBar: collection items.
  const pages = pagesQuery.data ?? [];
  const isLoading = pagesQuery.isLoading;

  function publicUrl(page: PageListItem): string {
    return `${window.location.origin}/p/${page.slug}`;
  }

  function editPage(id: string) {
    router.history.push(`/editor/${id}`);
  }

  async function copyLink(page: PageListItem) {
    await navigator.clipboard.writeText(publicUrl(page));
    toast.success("Link copied");
  }

  async function removePage(page: PageListItem) {
    if (!confirm(`Delete "${page.title}"?`)) return;
    await deletePageAction({ id: page.id }).when("settled");
    toast.success("Page deleted");
  }

  return (
    <AppShell>
      <div className="dashboard">
        <div className="dashboard-header">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="-ml-1" />
            <div>
              <div className="dashboard-title font-mono text-[10px] font-medium tracking-widest uppercase">
                My Pages
              </div>
              {!isLoading && (
                <div className="dashboard-count font-mono">
                  {pages.length} pages
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link to="/editor" className="btn-primary">
              <Plus size={13} strokeWidth={1.75} />
              New Page
            </Link>
          </div>
        </div>

        {isLoading ? (
          <div className="dashboard-loading">
            <div className="loading-dots">
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : pages.length === 0 ? (
          <div className="empty-state tui-panel relative">
            <FileText size={40} strokeWidth={1.25} className="empty-icon" />
            <div className="empty-title">No pages yet</div>
            <div className="empty-sub">
              Create your first page to start sharing.
            </div>
            <Link to="/editor" className="btn-primary">
              <Plus size={13} strokeWidth={1.75} />
              Create a page
            </Link>
          </div>
        ) : (
          <div className="page-list tui-panel relative">
            {pages.map((page) => (
              <div
                key={page.id}
                className="page-row"
                onClick={() => editPage(page.id)}
              >
                <div className="page-row-info">
                  <div className="page-row-title">
                    {page.title || "Untitled"}
                  </div>
                  <div className="page-row-meta">
                    <span className="page-slug">/{page.slug}</span>
                    <span
                      className={`badge ${page.isPublic ? "badge--public" : "badge--private"}`}
                    >
                      {page.isPublic ? "Public" : "Private"}
                    </span>
                    <span className="badge badge--type">
                      {page.contentType}
                    </span>
                  </div>
                </div>

                <div
                  className="page-row-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  {page.isPublic && (
                    <a
                      href={publicUrl(page)}
                      target="_blank"
                      rel="noreferrer"
                      className="action-btn"
                      title="Open"
                    >
                      <ExternalLink size={13} strokeWidth={1.75} />
                    </a>
                  )}
                  {page.isPublic && (
                    <button
                      className="action-btn"
                      title="Copy link"
                      onClick={() => void copyLink(page)}
                    >
                      <Copy size={13} strokeWidth={1.75} />
                    </button>
                  )}
                  <button
                    className="action-btn action-btn--danger"
                    title="Delete"
                    onClick={() => void removePage(page)}
                  >
                    <Trash2 size={13} strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

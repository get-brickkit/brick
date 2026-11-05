import { ErrorBoundary as ErrorBoundaryComponent } from "@workflow/web-shared";
import { useNavigate, useSearchParams } from "react-router";
import { HooksTable } from "~/components/hooks-table";
import { RunsTable } from "~/components/runs-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";

export default function Home() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const sidebar = searchParams.get("sidebar");
  const hookId = searchParams.get("hookId");
  const tab = searchParams.get("tab") || "runs";

  const setTab = (value: string) => {
    setSearchParams(
      (prev) => {
        prev.set("tab", value);
        return prev;
      },
      { replace: true },
    );
  };

  const selectedHookId = sidebar === "hook" && hookId ? hookId : undefined;

  const handleRunClick = (runId: string) => navigate(`/run/${runId}`);

  const handleHookSelect = (hookId: string, runId?: string) => {
    if (hookId) {
      navigate(`/run/${runId}?sidebar=hook&hookId=${hookId}`);
    } else {
      navigate(`/run/${runId}`);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4">
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="hooks">Hooks</TabsTrigger>
        </TabsList>
        <TabsContent value="runs">
          <ErrorBoundaryComponent title="Failed to load workflow runs">
            <RunsTable onRunClick={handleRunClick} />
          </ErrorBoundaryComponent>
        </TabsContent>
        <TabsContent value="hooks">
          <ErrorBoundaryComponent title="Failed to load hooks">
            <HooksTable
              onHookClick={handleHookSelect}
              selectedHookId={selectedHookId}
            />
          </ErrorBoundaryComponent>
        </TabsContent>
      </Tabs>
    </div>
  );
}

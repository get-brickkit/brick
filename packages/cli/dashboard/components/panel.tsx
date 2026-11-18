import type { ComponentProps, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The landing page's card: a square, 1px-bordered surface on the card color,
 * built on the shadcn Card with its radius and ring removed. A `title` is a
 * heading row across the top.
 */
export function Panel({
  className,
  children,
  title,
  ...props
}: Omit<ComponentProps<"div">, "title"> & { title?: ReactNode }) {
  return (
    <Card
      className={cn(
        "relative min-w-0 gap-0 rounded-none border bg-card py-0 ring-0",
        className,
      )}
      {...props}
    >
      {title !== undefined && (
        <div className="border-b px-4 py-3 text-sm font-medium">{title}</div>
      )}
      {children}
    </Card>
  );
}

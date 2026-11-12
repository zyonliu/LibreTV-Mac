import { Suspense } from "react";
import { DesktopShell } from "@/components/desktop/shell";
import "./desktop.css";
export default function Page() {
  return (
    <Suspense>
      <DesktopShell />
    </Suspense>
  );
}

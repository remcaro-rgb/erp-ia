import { Suspense } from "react";
import { GridRoute } from "../_components/grid-route";

// The core.party grid (design §9, prototype `renderGridPage`): server-driven over the masked view, in the shell's tab.
export default function PartiesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="core.party" href="/parties" />
    </Suspense>
  );
}

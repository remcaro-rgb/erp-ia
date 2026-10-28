import { Suspense } from "react";
import { SupportRoute } from "./support-route";

// The support screen (design §8, prototype v5 shell): the tickets grid and, on a row, the ticket with its conversation.
export default function SupportPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <SupportRoute />
    </Suspense>
  );
}

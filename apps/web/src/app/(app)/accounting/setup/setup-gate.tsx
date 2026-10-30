"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

export const SETUP_HREF = "/accounting/setup";

/** While the company is not configured only the setup page shows; any other accounting page replaces itself with it. */
export function SetupGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const onSetup = pathname === SETUP_HREF;
  useEffect(() => {
    if (!onSetup) router.replace(SETUP_HREF);
  }, [onSetup, router]);
  return onSetup ? children : null;
}

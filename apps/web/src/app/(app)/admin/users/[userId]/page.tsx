import { Suspense } from "react";
import { notFound } from "next/navigation";
import { loadUser } from "@/lib/admin/load";
import { AdminRoute } from "../../_components/admin-route";
import { UserScreen } from "./user-screen";

// A user's page under Administración › Usuarios (design §22.16, rule 21): where every reference to a user leads (the audit's
// actor, a ticket's reporter, the users list). The company admin only; a user who is not a member of the company is not found.

async function UserRoute({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return <AdminRoute load={() => loadUser(userId)} render={(data) => (data.member ? <UserScreen data={data} /> : notFound())} />;
}

export default function UserPage({ params }: { params: Promise<{ userId: string }> }) {
  // The session cookie and the route params are request data: read them inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <UserRoute params={params} />
    </Suspense>
  );
}

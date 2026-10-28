import { Suspense } from "react";
import { loadUsers } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { UsersScreen } from "./users-screen";

// Usuarios: the company's members, created and invited by the admin (design §6, prototype v5 "Usuarios").
export default function UsersPage() {
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadUsers} render={(data) => <UsersScreen data={data} />} />
    </Suspense>
  );
}

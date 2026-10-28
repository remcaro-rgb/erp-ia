// The sign-in surface: a centred card on the navy gradient of the approved prototype.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(1200px_600px_at_20%_-10%,#2A4A9E_0,#1E3A8A_40%,#0F2159_100%)] p-4">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl bg-white p-6 text-slate-900 shadow-xl dark:bg-slate-900 dark:text-slate-100">{children}</div>
    </main>
  );
}

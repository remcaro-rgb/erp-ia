import { NotFoundCard } from "./(app)/_components/not-found-view";

// Any address the application does not have, outside the shell: the same card, on the page background.
export default function NotFound() {
  return (
    <main className="erp-notfound-page">
      <NotFoundCard />
    </main>
  );
}

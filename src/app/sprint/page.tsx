// Sprint is now the root page.
// This file exists only so /sprint doesn't 404 — it redirects to /.
import { redirect } from "next/navigation";
export default function SprintRedirect() {
  redirect("/");
}

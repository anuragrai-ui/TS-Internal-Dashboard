import { redirect } from "next/navigation";

import { clearCache } from "@/lib/cache";

export function GET(): never {
  clearCache();
  redirect("/");
}

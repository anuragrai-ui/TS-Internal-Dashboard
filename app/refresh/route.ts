import { redirect } from "next/navigation";

import { clearCache } from "@/lib/cache";

export async function GET(): Promise<never> {
  await clearCache();
  redirect("/");
}

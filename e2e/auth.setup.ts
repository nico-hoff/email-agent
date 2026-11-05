// Signs in once, stores the session for the other projects (fewer logins, no rate limit in the run) and warms the
// production server up: it compiles every page and route on first use (cold about 25 s, then about 2 s).
import { expect, test as setup } from "@playwright/test";
import { AUTH_FILE, expectList, signIn } from "./helpers.ts";

const WARM = 60_000;

setup("anmelden, Sitzung speichern, Seiten vorwärmen", async ({ page }) => {
  setup.setTimeout(4 * WARM);
  await signIn(page);
  await expectList(page, WARM);
  await page.context().storageState({ path: AUTH_FILE });
  await page.locator("a[href^='/emails/']").first().click();
  await expect(page.getByRole("region", { name: "Überblick" })).toBeVisible({ timeout: WARM });
  for (const [path, heading] of [["/profil", "Profil"], ["/aussortiert", "Aussortiert"], ["/absender", "Absender"]] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({ timeout: WARM });
    // Wait until the client-side loads (and their API routes) are done, not only the server-rendered heading.
    await expect(page.getByRole("status").filter({ hasText: "Lädt" })).toHaveCount(0, { timeout: WARM });
  }
});

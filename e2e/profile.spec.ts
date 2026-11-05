import { expect, test } from "@playwright/test";
import { expectList, signIn } from "./helpers.ts";

// Own session: logging out revokes it on the server, the shared session of the other tests stays valid.
test.use({ storageState: { cookies: [], origins: [] } });

test("Menü zum Profil, abmelden", async ({ page }) => {
  await signIn(page);
  await expectList(page);
  await page.getByRole("button", { name: "Weitere Seiten" }).click();
  await page.getByRole("menuitem", { name: "Profil" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Profil" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Sitzungen" })).toBeVisible();
  await page.getByRole("button", { name: "Abmelden", exact: true }).click();
  await expect(page).toHaveURL(/\/welcome/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome/);
});

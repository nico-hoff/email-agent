import { expect, test } from "@playwright/test";
import { expectList, signIn } from "./helpers.ts";

test.describe("Anmeldung", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("ohne Sitzung leitet die Liste zur Anmeldung", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/welcome/);
    await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
  });

  test("falsches Passwort zeigt einen Hinweis, richtiges führt zur Liste", async ({ page }) => {
    await signIn(page, "falsch-falsch");
    await expect(page.getByRole("alert")).toBeVisible();
    await signIn(page);
    await expectList(page);
  });
});

import { expect, test } from "@playwright/test";
import { expectList } from "./helpers.ts";

test("Detailansicht: erledigen, wieder öffnen, zurück zur Liste", async ({ page }) => {
  await page.goto("/");
  await expectList(page);
  await page.locator("a[href^='/emails/']").first().click();
  await expect(page).toHaveURL(/\/emails\/\d+/);
  await expect(page.getByRole("region", { name: "Überblick" })).toBeVisible();
  const toggle = page.getByRole("button", { name: /^(Als erledigt markieren|Wieder öffnen)$/ });
  const before = (await toggle.textContent()) ?? "";
  const after = before === "Wieder öffnen" ? "Als erledigt markieren" : "Wieder öffnen";
  await toggle.click();
  await expect(page.getByRole("button", { name: after, exact: true })).toBeVisible();
  await page.getByRole("button", { name: after, exact: true }).click();
  await expect(page.getByRole("button", { name: before, exact: true })).toBeVisible();
  await page.getByRole("link", { name: /Liste/ }).click();
  await expectList(page);
});

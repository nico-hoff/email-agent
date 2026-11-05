import { expect, test } from "@playwright/test";
import { expectList } from "./helpers.ts";

test.describe("Liste", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expectList(page);
  });

  test("Ansichten wechseln", async ({ page }) => {
    const views = page.getByRole("group", { name: "Ansicht" }).getByRole("button");
    const n = await views.count();
    expect(n).toBeGreaterThan(1);
    for (let i = 0; i < n; i++) {
      await views.nth(i).click();
      await expect(views.nth(i)).toHaveAttribute("aria-pressed", "true");
    }
  });

  test("Mail erledigen und rückgängig machen", async ({ page }) => {
    const done = page.getByRole("button", { name: /^Als erledigt markieren: / }).first();
    await expect(done).toBeVisible();
    const label = (await done.getAttribute("aria-label")) ?? "";
    await done.click();
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await page.getByRole("status").getByRole("button", { name: "Rückgängig" }).click();
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  });
});

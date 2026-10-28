import { describe, expect, it, vi } from "vitest";
import { createLayoutSaver } from "./layout-save";

// Saving the home layout: the server action for an immediate save, and the pagehide beacon (the one the shell uses for
// tabs) for a save that has not landed when the page goes away.

const layout = [{ id: "kpis", w: 4, h: 170 }];

function setup(action: (input: unknown) => Promise<{ ok: boolean }>) {
  const beacon = vi.fn();
  const saver = createLayoutSaver({ action, beacon });
  return { saver, beacon };
}

describe("createLayoutSaver", () => {
  it("sends the layout through the action and keeps nothing pending once it is stored", async () => {
    const action = vi.fn(async () => ({ ok: true }));
    const { saver, beacon } = setup(action);
    await saver.save(layout, 10);
    expect(action).toHaveBeenCalledWith({ key: "home_layout", value: layout, savedAt: 10 });
    saver.pageHide();
    expect(beacon).not.toHaveBeenCalled();
  });

  it("a save still in flight when the page hides goes out as a beacon", () => {
    const { saver, beacon } = setup(() => new Promise(() => {}));
    void saver.save(layout, 20);
    saver.pageHide();
    expect(beacon).toHaveBeenCalledWith({ key: "home_layout", value: layout, savedAt: 20 });
  });

  it("only the latest layout is beaconed, and a refused or failed save stays pending", async () => {
    const action = vi.fn().mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error("network"));
    const { saver, beacon } = setup(action);
    await saver.save(layout, 30);
    await saver.save([{ id: "help", w: 2, h: 300 }], 40);
    saver.pageHide();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon).toHaveBeenCalledWith({ key: "home_layout", value: [{ id: "help", w: 2, h: 300 }], savedAt: 40 });
  });

  it("an older save finishing after a newer one does not clear the newer pending save", async () => {
    let finishFirst!: (v: { ok: boolean }) => void;
    const action = vi.fn().mockImplementationOnce(() => new Promise((r) => (finishFirst = r))).mockImplementationOnce(() => new Promise(() => {}));
    const { saver, beacon } = setup(action);
    void saver.save(layout, 50);
    void saver.save([{ id: "help", w: 1, h: 200 }], 60);
    finishFirst({ ok: true });
    await Promise.resolve();
    saver.pageHide();
    expect(beacon).toHaveBeenCalledWith({ key: "home_layout", value: [{ id: "help", w: 1, h: 200 }], savedAt: 60 });
  });
});

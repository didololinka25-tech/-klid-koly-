import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const manualImage = readFileSync(
  new URL("../public/manuals/manual-open-close-school.jpg", import.meta.url),
);

test("the supplied opening and closing manual is stored as the unchanged JPG asset", () => {
  assert.equal(manualImage[0], 0xff);
  assert.equal(manualImage[1], 0xd8);
  assert.ok(manualImage.length > 100_000);
  assert.equal(
    createHash("sha256").update(manualImage).digest("hex"),
    "ccfb70c65f3938efe3949b9e591a81caf5d0c4994541760379bcc84354750f2f",
  );
});

test("one shared manual viewer opens from Today and Manual quick guides", () => {
  assert.match(appSource, /const schoolOpeningManualAsset = "\/manuals\/manual-open-close-school\.jpg"/);
  assert.match(appSource, /Otevření \/ zavření školy/);
  assert.match(appSource, /Rychlé návody/);
  assert.match(appSource, /function SchoolOpeningManualModal/);
  assert.ok(
    appSource.match(/setSchoolOpeningManualOpen\(true\)/g)?.length >= 2,
    "viewer must be reachable from both Today and Manual",
  );
});

test("manual viewer keeps the image responsive and provides touch-sized controls", () => {
  assert.match(styles, /\.today-school-manual-link\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.school-manual-close\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s);
  assert.match(styles, /\.school-manual-image-button img\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*height:\s*auto/s);
  assert.match(styles, /\.school-manual-lightbox\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/s);
  assert.match(styles, /\.school-manual-viewer\s*\{[^}]*width:\s*min\(760px,\s*100%\)[^}]*max-width:\s*100%/s);
});

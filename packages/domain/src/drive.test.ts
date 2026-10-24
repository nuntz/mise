import { describe, expect, test } from "bun:test";
import { SAMPLE_JPEG, utf8, zip } from "../../../fixtures/paprika";
import { docText, firstDocImage, importedFromDoc } from "./drive";
import type { RecipeReading } from "./llm";

/** A Doc as Drive exports it to Markdown: an image is a reference, defined at the end as a data URI. */
const WITH_IMAGE = [
  "# Grandma's Lentil Soup",
  "",
  "![][image1]",
  "",
  "* 1 cup red lentils",
  "* 1 onion, diced",
  "",
  "Simmer for 30 minutes.",
  "",
  "[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==>",
].join("\n");

describe("reading a Doc's Markdown", () => {
  test("gives the model its text without the images", () => {
    const read = docText(WITH_IMAGE);

    expect(read.text).toBe(
      ["# Grandma's Lentil Soup", "", "* 1 cup red lentils", "* 1 onion, diced", "", "Simmer for 30 minutes."].join(
        "\n",
      ),
    );
    expect(read.hasImage).toBe(true);
  });

  test("knows a Doc without images, inline or by reference", () => {
    expect(docText("# Toast\n\nToast the bread.")).toEqual({ text: "# Toast\n\nToast the bread.", hasImage: false });
    expect(docText("# Toast\n\n![toast](https://example.com/toast.jpg)\nToast it.")).toEqual({
      text: "# Toast\n\nToast it.",
      hasImage: true,
    });
  });
});

/** The start of a PNG: enough for Mise to recognise it as one. */
const SAMPLE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

describe("finding a Doc's photo in its zipped HTML export", () => {
  test("gives the image the Doc shows first, whatever the zip's order", async () => {
    const exported = await zip([
      { name: "images/image1.jpg", data: SAMPLE_JPEG },
      { name: "images/image2.png", data: SAMPLE_PNG },
      {
        name: "GrandmasLentilSoup.html",
        data: utf8(
          '<html><body><p><img alt="" src="images/image2.png" style="width: 624px"></p><p><img src="images/image1.jpg"></p></body></html>',
        ),
      },
    ]);

    expect(await firstDocImage(exported)).toEqual({ bytes: SAMPLE_PNG, type: "image/png" });
  });

  test("gives none when the export has no image Mise can use", async () => {
    const html = (body: string) => ({ name: "Doc.html", data: utf8(`<html><body>${body}</body></html>`) });

    expect(await firstDocImage(await zip([html("<p>No pictures</p>")]))).toBeNull();
    expect(
      await firstDocImage(
        await zip([html('<img src="images/image1.bmp">'), { name: "images/image1.bmp", data: utf8("BM") }]),
      ),
    ).toBeNull();
    expect(await firstDocImage(utf8("not a zip"))).toBeNull();
  });
});

const soup: Extract<RecipeReading, { isRecipe: true }> = {
  isRecipe: true,
  title: "Grandma's Lentil Soup",
  ingredients: ["1 cup red lentils", "1 onion, diced"],
  steps: ["Simmer for 30 minutes."],
  servings: null,
  minutes: 30,
  course: "side",
};

describe("a Doc read by the model, as a Recipe", () => {
  test("is upserted on the Doc's id at its modified time, linking to the Doc", () => {
    const doc = { id: "1AbCdEf", name: "Lentil soup", modifiedTime: "2026-10-20T08:15:00.000Z", folders: [] };

    expect(importedFromDoc(doc, soup)).toMatchObject({
      externalId: "1AbCdEf",
      revision: "2026-10-20T08:15:00.000Z",
      url: "https://docs.google.com/document/d/1AbCdEf/edit",
      title: "Grandma's Lentil Soup",
      baseServings: 4,
      effortMinutes: 30,
      ingredients: ["1 cup red lentils", "1 onion, diced"],
      tags: [],
      course: "side",
    });
  });

  test("takes its subfolders as tags, read as Paprika's categories are", () => {
    const doc = {
      id: "1AbCdEf",
      name: "Lentil soup",
      modifiedTime: "2026-10-20T08:15:00.000Z",
      folders: ["Indian", "Weeknight"],
    };

    expect(importedFromDoc(doc, soup)).toMatchObject({
      tags: ["indian", "weeknight"],
      cuisine: "indian",
      // A folder that names a Course wins over the model's guess.
      course: "main",
    });
  });
});

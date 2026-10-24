import { describe, expect, test } from "bun:test";
import { captionTitle, instagramTitle, videoLinkOf } from "./videos";

describe("recognising a video link", () => {
  test("gives a TikTok video's canonical URL, without what a share adds", () => {
    expect(videoLinkOf("https://www.tiktok.com/@cook.example/video/7301234567890123456?is_from_webapp=1&_r=1")).toEqual(
      {
        site: "tiktok",
        video: "https://www.tiktok.com/@cook.example/video/7301234567890123456",
        short: false,
      },
    );
    expect(videoLinkOf("https://m.tiktok.com/@cook.example/video/7301234567890123456/")).toEqual({
      site: "tiktok",
      video: "https://www.tiktok.com/@cook.example/video/7301234567890123456",
      short: false,
    });
  });

  test("knows a TikTok short link, to follow to its video, from any other TikTok page", () => {
    expect(videoLinkOf("https://vm.tiktok.com/ZMabcdef/")).toEqual({ site: "tiktok", video: null, short: true });
    expect(videoLinkOf("https://vt.tiktok.com/ZSabcdef/")).toEqual({ site: "tiktok", video: null, short: true });
    expect(videoLinkOf("https://www.tiktok.com/t/ZTabcdef/")).toEqual({ site: "tiktok", video: null, short: true });
    expect(videoLinkOf("https://www.tiktok.com/@cook.example")).toEqual({ site: "tiktok", video: null, short: false });
  });

  test("gives an Instagram post's or reel's canonical URL", () => {
    expect(videoLinkOf("https://www.instagram.com/reel/Cabc123_-x/?igsh=xyz")).toEqual({
      site: "instagram",
      url: "https://www.instagram.com/reel/Cabc123_-x/",
    });
    expect(videoLinkOf("https://instagram.com/p/Cabc123")).toEqual({
      site: "instagram",
      url: "https://www.instagram.com/p/Cabc123/",
    });
    expect(videoLinkOf("https://instagr.am/p/Cabc123/")).toEqual({
      site: "instagram",
      url: "https://www.instagram.com/p/Cabc123/",
    });
    expect(videoLinkOf("https://www.instagram.com/cook.example/?utm_source=share")).toEqual({
      site: "instagram",
      url: "https://www.instagram.com/cook.example/",
    });
  });

  test("leaves every other link to be read as a page", () => {
    expect(videoLinkOf("https://kitchen.example.com/recipes/red-lentil-dal/")).toBeNull();
    expect(videoLinkOf("https://nottiktok.com/@cook.example/video/1")).toBeNull();
  });
});

describe("titling an Instagram link", () => {
  test("says what it links to", () => {
    expect(instagramTitle("https://www.instagram.com/reel/Cabc123/")).toBe("Instagram reel");
    expect(instagramTitle("https://www.instagram.com/p/Cabc123/")).toBe("Instagram post");
    expect(instagramTitle("https://www.instagram.com/cook.example/")).toBe("Instagram link");
  });
});

describe("titling a video from its caption", () => {
  test("takes the caption's first line, without hashtags or mentions", () => {
    expect(captionTitle("Crispy chilli tofu 🌶️ #tofu #dinner @friend\n\n200 g tofu…", "cook.example")).toBe(
      "Crispy chilli tofu 🌶️",
    );
  });

  test("cuts a long first line at a word", () => {
    const title = captionTitle(`${"the best weeknight noodles ".repeat(10)}ever`, "cook.example");
    expect(title.length).toBeLessThanOrEqual(101);
    expect(title).toEndWith("…");
    expect(title).toStartWith("the best weeknight noodles the best");
    expect(title).not.toContain("noodl…");
  });

  test("names the video by its author when the caption says nothing", () => {
    expect(captionTitle("#recipe #fyp", "cook.example")).toBe("TikTok video by cook.example");
    expect(captionTitle("", null)).toBe("TikTok video");
  });
});

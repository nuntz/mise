# Share to Mise from an iPhone

iOS has no Web Share Target, so "Mise" in the share sheet is an iOS Shortcut. It takes the link
you shared and opens `https://<your Mise host>/share?url=<the link>` in Safari. That page is behind
Access like every other page of Mise: it imports the link and shows what it became, a Recipe or a
Draft waiting on the Review screen, with a link to it.

Each person builds the Shortcut on their own iPhone, once. It holds nothing secret: only your host.

## Build the Shortcut

In the Shortcuts app:

1. Tap **+** to start a new shortcut and name it **Mise** (the name the share sheet shows).
2. Open the shortcut's details (the **ⓘ** button, or the name's menu → **Details**) and turn on
   **Show in Share Sheet**. Back in the editor, the first block reads "Receive … from Share Sheet":
   tap its input types and keep only **URLs**, **Safari web pages** and **Text** (TikTok and some
   other apps share a link inside text). Set "If there's no input" to **Stop and Respond**.
3. Add **Get URLs from Input**, with **Shortcut Input** as its input.
4. Add **Get Item from List**, set to **First Item** of the URLs.
5. Add **URL Encode**, set to **Encode**, with the **Item from List** variable as its input. It holds
   only the shared link, never your host: Mise's address goes in the next action.
6. Add a separate **Text** action (search the actions for "Text"). Type
   `https://mise.example.com/share?url=` in it, then insert the **URL Encoded Text** variable right
   after the `=`, with no space (tap the variable bar above the keyboard). Use your own host in place
   of `mise.example.com`.
7. Add **Open URLs**, with the **Text** variable as its input.

When it's done, the shortcut reads:

```
Receive URLs and 2 more from Share Sheet
Get URLs from Shortcut Input
Get First Item from URLs
URL Encode  Item from List
Text  https://mise.example.com/share?url=[URL Encoded Text]
Open  Text
```

Tap **Done**. Sharing from Safari, TikTok or any other app now lists **Mise** in the share sheet
(scroll the row of actions to the end and tap **Edit Actions** to move it up).

**Open URLs** uses the iPhone's default browser. If that isn't Safari, the share page opens in that
browser instead, which signs in on its own the same way.

## The first share signs Safari in

Safari keeps its own sign-in, apart from Mise added to the home screen. So the first link you share
opens the Access sign-in in Safari: sign in with the same account you use for Mise, and Safari comes
back to the share page, which imports the link. Every share after that goes straight in, until the
Access session ends.

If the share page ever says Safari isn't signed in, tap **Sign in and import the link**.

## Check it

Share a recipe page from Safari and a video from the TikTok app. Each should open the share page,
which says what the link became and links to it: a Recipe opens in Recipes, and a Draft opens on the
Review screen. A link Mise can't read becomes a link-only Draft, and the share page offers a box to
paste the recipe's text into it.

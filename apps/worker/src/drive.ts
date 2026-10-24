import type { DriveDoc } from "@mise/domain";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";

type Fetch = typeof fetch;

/** The Google Drive folder a deployment syncs, read through the service account it is shared with. */
export type Drive = {
  /** Every Google Doc in the folder and its subfolders, not trashed. Throws `DriveError`. */
  listDocs(): Promise<DriveDoc[]>;
  /** A Doc exported as Markdown. Throws `DriveError`. */
  markdown(id: string): Promise<string>;
  /** A Doc exported as zipped HTML: the page, and its images under `images/`. Throws `DriveError`. */
  zippedHtml(id: string): Promise<Uint8Array<ArrayBuffer>>;
};

/** Drive could not be reached, or refused: the message says what to do, as a sentence. */
export class DriveError extends Error {}

/** The fields of a service account's JSON key the sync uses. */
export const ServiceAccountKey = z.object({ client_email: z.string().min(1), private_key: z.string().min(1) });
export type ServiceAccountKey = z.infer<typeof ServiceAccountKey>;

/** What opening the Drive folder needs from the Worker's environment (Worker secrets, ADR 0005). */
type DriveEnv = { GOOGLE_SERVICE_ACCOUNT_KEY?: string; DRIVE_FOLDER_ID?: string };

let replacement: ((env: DriveEnv) => Drive | null) | undefined;

/**
 * Makes households sync another Drive from their next sync, or Google's again with `undefined`.
 * Tests serve a pretend Google API this way, so no test reaches a real Drive.
 */
export function useDrive(open: ((env: DriveEnv) => Drive | null) | undefined): void {
  replacement = open;
}

/** The deployment's Drive folder; null when it has no service account key or folder id. */
export function openDrive(env: DriveEnv): Drive | null {
  if (replacement) return replacement(env);
  const folder = env.DRIVE_FOLDER_ID?.trim();
  if (!env.GOOGLE_SERVICE_ACCOUNT_KEY || !folder) return null;
  let key: ServiceAccountKey;
  try {
    key = ServiceAccountKey.parse(JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY));
  } catch {
    return brokenDrive("The service account key is not a Google service account's JSON key");
  }
  return googleDrive(key, folder, fetch);
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";
const TIMEOUT_MS = 30_000;
/** Drive exports no more than 10 MB of a Doc. */
const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
/** How many folders deep the sync looks, and how many Docs it lists at most: a folder, not a Drive. */
const MAX_DEPTH = 10;
const MAX_DOCS = 5000;

const Token = z.object({ access_token: z.string().min(1) });
const FileList = z.object({
  nextPageToken: z.string().optional(),
  files: z.array(z.object({ id: z.string(), name: z.string(), mimeType: z.string(), modifiedTime: z.iso.datetime() })),
});

/**
 * The folder `folderId` on Google Drive, read as the service account `key`, which the folder must be
 * shared with: a JWT it signs is exchanged for a read-only token, kept for the sync.
 */
export function googleDrive(key: ServiceAccountKey, folderId: string, fetcher: Fetch): Drive {
  let token: Promise<string> | undefined;

  const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
    try {
      return await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new DriveError("Google could not be reached");
    }
  };

  const signIn = async (): Promise<string> => {
    let assertion: string;
    try {
      assertion = await new SignJWT({ scope: SCOPE })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(key.client_email)
        .setAudience(TOKEN_URL)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(await importPKCS8(key.private_key, "RS256"));
    } catch {
      throw new DriveError("The service account key's private key could not be read");
    }
    const response = await request(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const answer = Token.safeParse(response.ok ? await response.json().catch(() => null) : null);
    if (!answer.success) {
      throw new DriveError(`Google refused the service account key (HTTP ${response.status}): check the Worker secret`);
    }
    return answer.data.access_token;
  };

  /** GETs a Drive URL with the token; a refusal throws, saying `what` could not be had. */
  const get = async (url: string, what: string): Promise<Response> => {
    token ??= signIn();
    const response = await request(url, { headers: { Authorization: `Bearer ${await token}` } });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new DriveError(`${what} was not found: share the folder with ${key.client_email}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DriveError(`${what} was refused by Google (HTTP ${response.status})`);
    }
    return response;
  };

  const exportDoc = async (id: string, mimeType: string): Promise<Uint8Array<ArrayBuffer>> => {
    const url = `${FILES_URL}/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mimeType)}`;
    const response = await get(url, "The Doc");
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_EXPORT_BYTES) throw new DriveError("The Doc is larger than Drive exports");
    return body;
  };

  return {
    async listDocs() {
      // Only to say the folder isn't shared: listing a folder Mise can't see answers no files.
      const folder = `${FILES_URL}/${encodeURIComponent(folderId)}?fields=id&supportsAllDrives=true`;
      await (await get(folder, "The Drive folder")).body?.cancel();
      const docs: DriveDoc[] = [];
      const seen = new Set([folderId]);
      const folders = [{ id: folderId, path: [] as string[] }];
      for (let folder = folders.shift(); folder; folder = folders.shift()) {
        let pageToken: string | undefined;
        do {
          const query = new URLSearchParams({
            q: `'${folder.id}' in parents and trashed = false and (mimeType = '${DOC_MIME}' or mimeType = '${FOLDER_MIME}')`,
            fields: "nextPageToken,files(id,name,mimeType,modifiedTime)",
            pageSize: "1000",
            orderBy: "name",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            ...(pageToken && { pageToken }),
          });
          const page = FileList.safeParse(await (await get(`${FILES_URL}?${query}`, "The Drive folder")).json());
          if (!page.success) throw new DriveError("Drive's list of the folder could not be read");
          for (const file of page.data.files) {
            if (file.mimeType === DOC_MIME) {
              docs.push({ id: file.id, name: file.name, modifiedTime: file.modifiedTime, folders: folder.path });
            } else if (!seen.has(file.id) && folder.path.length < MAX_DEPTH) {
              // A folder can be in two places at once; it is read in the first.
              seen.add(file.id);
              folders.push({ id: file.id, path: [...folder.path, file.name] });
            }
          }
          if (docs.length > MAX_DOCS) throw new DriveError(`The folder holds more than ${MAX_DOCS} Docs`);
          pageToken = page.data.nextPageToken;
        } while (pageToken);
      }
      return docs;
    },

    async markdown(id) {
      return new TextDecoder().decode(await exportDoc(id, "text/markdown"));
    },

    zippedHtml: (id) => exportDoc(id, "application/zip"),
  };
}

/** A Drive that only says why it can't be read, so the sync logs it rather than failing unseen. */
function brokenDrive(message: string): Drive {
  const fail = async (): Promise<never> => {
    throw new DriveError(message);
  };
  return { listDocs: fail, markdown: fail, zippedHtml: fail };
}

/** A Doc as a sync last read it: its modified time then. */
const DriveDocRecord = z.object({ docId: z.string().min(1), modifiedTime: z.iso.datetime() });

/** Every Doc a Drive sync read; parsed, so bad rows throw (a restore checks them this way). */
export function readDriveDocs(sql: SqlStorage): z.infer<typeof DriveDocRecord>[] {
  return sql
    .exec<{ doc_id: string; modified_time: string }>("SELECT doc_id, modified_time FROM drive_doc ORDER BY doc_id")
    .toArray()
    .map((row) => DriveDocRecord.parse({ docId: row.doc_id, modifiedTime: row.modified_time }));
}

/** The modified time of the Doc `id` when a Drive sync last read it; undefined if never. */
export function driveRevision(sql: SqlStorage, id: string): string | undefined {
  return sql.exec<{ modified_time: string }>("SELECT modified_time FROM drive_doc WHERE doc_id = ?", id).toArray()[0]
    ?.modified_time;
}

/** Records that a sync read `docs` at their modified times, recipes or not. */
export function recordDriveDocs(sql: SqlStorage, docs: DriveDoc[]): void {
  for (const doc of docs) {
    sql.exec(
      `INSERT INTO drive_doc (doc_id, modified_time) VALUES (?, ?)
       ON CONFLICT (doc_id) DO UPDATE SET modified_time = excluded.modified_time`,
      doc.id,
      doc.modifiedTime,
    );
  }
}

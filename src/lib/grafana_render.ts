import axios from "axios";
import { MatrixClient, MsgType } from "matrix-js-sdk";

/**
 * Fetch a Grafana render URL and upload the image to a Matrix room.
 * Throws on HTTP errors or if Grafana returns a non-image content-type.
 */
export async function renderAndUpload(
  client: MatrixClient,
  roomId: string,
  url: string,
  grafanaToken: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (grafanaToken) {
    headers["Authorization"] = `Bearer ${grafanaToken}`;
  }

  const response = await axios.get<Buffer>(url, {
    headers,
    responseType: "arraybuffer",
    timeout: 30_000,
  });

  const contentType: string =
    (response.headers["content-type"] as string) || "image/png";

  if (!contentType.startsWith("image/")) {
    throw new Error(
      `Grafana returned \`${contentType}\` instead of an image — check the render path.`
    );
  }

  const rawName = url.split("?")[0]!.split("/").pop() || "graph";
  const filename = rawName.includes(".") ? rawName : `${rawName}.png`;

  const urlParams = new URL(url).searchParams;
  const w = parseInt(urlParams.get("width") ?? "", 10) || undefined;
  const h = parseInt(urlParams.get("height") ?? "", 10) || undefined;

  const upload = await client.uploadContent(
    Buffer.from(response.data),
    { type: contentType, name: filename },
  );

  await client.sendMessage(roomId, {
    msgtype: MsgType.Image,
    body: filename,
    url: upload.content_uri,
    info: { mimetype: contentType, w, h },
  });
}

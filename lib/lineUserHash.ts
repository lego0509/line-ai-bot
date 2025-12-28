import { createHmac } from "node:crypto";

/**
 * LINE userId を匿名化して DB に保存するための安定ハッシュ
 * - HMAC-SHA256(pepper, userId) を hex(64文字)で返す
 * - pepper未設定は「ユーザー分裂」するので即throw
 */
export function lineUserIdToHash(lineUserId: string): string {
  const pepper = process.env.LINE_HASH_PEPPER;
  if (!pepper) throw new Error("LINE_HASH_PEPPER is not set");

  return createHmac("sha256", pepper).update(lineUserId, "utf8").digest("hex");
}

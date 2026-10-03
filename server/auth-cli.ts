import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { openDB } from "./db.js";
import { migrate } from "./migrate.js";
import { createLocalAccount, resetLocalPassword } from "./auth.js";

async function main() {
  const command = process.argv[2];
  if (
    !["create-admin", "reset-password"].includes(command) ||
    process.argv.length !== 3
  )
    throw new Error(
      "Usage: npm run auth:create-admin | npm run auth:reset-password",
    );
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("请在交互终端中执行，密码通过隐藏输入提供");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  let db;
  try {
    const username = await rl.question("用户名：");
    const name =
      command === "create-admin" ? await rl.question("显示姓名：") : "";
    process.stdout.write("密码（15～128 个字符）：");
    muted = true;
    const password = await rl.question("");
    muted = false;
    process.stdout.write("\n确认密码：");
    muted = true;
    const confirmation = await rl.question("");
    muted = false;
    process.stdout.write("\n");
    if (password !== confirmation) throw new Error("两次密码输入需要一致");
    db = await openDB();
    await migrate(db);
    if (command === "create-admin")
      await createLocalAccount(db, { username, name, password }, "admin");
    else await resetLocalPassword(db, username, password);
    console.log(
      command === "create-admin"
        ? "管理员已创建"
        : "密码已重置，所有会话已撤销",
    );
  } finally {
    rl.close();
    await db?.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

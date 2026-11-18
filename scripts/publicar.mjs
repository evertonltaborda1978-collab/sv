// Publica as alterações do projeto no GitHub (git add + commit + push) de uma vez.
//
// Como usar (na pasta principal do projeto, trabalhoeverton):
//   node scripts/publicar.mjs "v5.34 - Leitura acompanhada e proteção das notas"
//
// A mensagem entre aspas é o "Summary" do commit. Funciona no PowerShell e no terminal do
// Android Studio, e sempre atua na pasta principal do projeto, mesmo que o terminal esteja em \android.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Pasta principal do projeto = uma pasta acima de "scripts"
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(raiz);

const git = (args, herdarTela = false) =>
  spawnSync("git", args, herdarTela ? { stdio: "inherit" } : { encoding: "utf8" });

const sair = (msg, codigo = 1) => {
  console.error(msg);
  process.exit(codigo);
};

const mensagem = process.argv.slice(2).join(" ").trim();
if (!mensagem) {
  sair(
    '✖ Faltou o texto do Summary.\n  Use assim: node scripts/publicar.mjs "v5.34 - o que mudou"',
  );
}

const versao = git(["--version"]);
if (versao.error || versao.status !== 0) {
  sair("✖ O Git não foi encontrado neste terminal. Use o GitHub Desktop: escreva o Summary, clique em Commit e depois em Push origin.");
}

const dentro = git(["rev-parse", "--is-inside-work-tree"]);
if (dentro.status !== 0) {
  sair(`✖ A pasta ${raiz} não é um repositório do Git.`);
}

const estado = git(["status", "--porcelain"]);
const linhas = (estado.stdout || "").split("\n").filter((l) => l.trim() !== "");
if (linhas.length === 0) {
  console.log("✔ Não há nada novo para enviar. O GitHub já está com tudo.");
  process.exit(0);
}

console.log(`\nPasta: ${raiz}`);
console.log(`Arquivos alterados: ${linhas.length}`);
linhas.slice(0, 20).forEach((l) => console.log("  " + l));
if (linhas.length > 20) console.log(`  ... e mais ${linhas.length - 20}`);
console.log("");

if (git(["add", "-A"], true).status !== 0) sair("✖ Não foi possível preparar os arquivos (git add).");

if (git(["commit", "-m", mensagem], true).status !== 0) {
  sair("✖ Não foi possível criar o commit. Leia a mensagem acima.");
}

console.log("\nEnviando para o GitHub...\n");
if (git(["push", "origin", "HEAD"], true).status !== 0) {
  sair(
    "\n✖ O envio (push) não funcionou. O commit ficou guardado no computador.\n" +
      "  Abra o GitHub Desktop e clique em Fetch origin / Pull origin e depois em Push origin.",
  );
}

// Endereço da aba Actions, para conferir o ✔ verde
let site = (git(["remote", "get-url", "origin"]).stdout || "").trim();
site = site.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");

console.log("\n✔ Enviado para o GitHub.");
if (site.startsWith("http")) {
  console.log(`  Confira em: ${site}/actions`);
  console.log("  Espere o círculo amarelo virar ✔ verde; aí o site no computador está atualizado.");
}

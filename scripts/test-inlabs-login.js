// Diagnostico de login INLABS - rode: node scripts/test-inlabs-login.js
require("dotenv").config();

async function testLogin() {
  const email = process.env.INLABS_EMAIL;
  const senha = process.env.INLABS_SENHA;

  if (!email || !senha) {
    console.error("INLABS_EMAIL ou INLABS_SENHA nao encontrados no .env");
    process.exit(1);
  }

  console.log("Tentando login com:", email);
  console.log("URL: https://inlabs.in.gov.br/logar.php\n");

  const body = new URLSearchParams({ email, password: senha }).toString();
  const res = await fetch("https://inlabs.in.gov.br/logar.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual"
  });

  console.log("Status HTTP:", res.status);
  console.log("Location:", res.headers.get("location") || "(nenhum)");
  console.log("\nTodos os headers Set-Cookie:");
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")];
  cookies.forEach((c, i) => console.log(`  [${i}]`, c));

  console.log("\nTodos os headers da resposta:");
  for (const [k, v] of res.headers.entries()) {
    console.log(`  ${k}: ${v}`);
  }

  // Tenta seguir o redirect e ver se o cookie funciona
  const allCookies = cookies.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
  console.log("\nCookies extraidos:", allCookies || "(nenhum)");

  if (allCookies) {
    console.log("\nTestando acesso autenticado a um ZIP do dia de hoje...");
    const today = new Date().toISOString().slice(0, 10);
    const testUrl = `https://inlabs.in.gov.br/index.php?p=${today}&dl=${today}-DO2.zip`;
    const r2 = await fetch(testUrl, { headers: { Cookie: allCookies }, redirect: "manual" });
    console.log("Status do download:", r2.status, "(esperado: 200 ou 302 com redirect para arquivo)");
    console.log("Content-Type:", r2.headers.get("content-type") || "(nenhum)");
    console.log("Content-Length:", r2.headers.get("content-length") || "(nenhum)");
  }
}

testLogin().catch(console.error);

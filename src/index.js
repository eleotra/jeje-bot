const MENU = {
  keyboard: [
    [{ text: "📚 Catalogue" }, { text: "🛒 Order Baru" }],
    [{ text: "👤 Buyer" }, { text: "📊 Today" }],
    [{ text: "💰 Keuangan" }, { text: "📅 Deadline" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

async function tg(env, method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function send(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...extra,
  });
}

async function answerCallback(env, queryId, text = "") {
  return tg(env, "answerCallbackQuery", {
    callback_query_id: queryId,
    text,
  });
}

function ownerOnly(update, env) {
  const id =
    update?.message?.from?.id ??
    update?.callback_query?.from?.id;
  return String(id) === String(env.OWNER_ID);
}

async function getSession(env, chatId) {
  return env.DB.prepare("SELECT * FROM sessions WHERE chat_id = ?")
    .bind(String(chatId)).first();
}

async function setSession(env, chatId, state, data = {}) {
  await env.DB.prepare(`
    INSERT INTO sessions(chat_id,state,data_json)
    VALUES(?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state,data_json=excluded.data_json
  `).bind(String(chatId), state, JSON.stringify(data)).run();
}

async function clearSession(env, chatId) {
  await env.DB.prepare("DELETE FROM sessions WHERE chat_id=?").bind(String(chatId)).run();
}

async function upsertBuyer(env, username) {
  const clean = username.trim();
  await env.DB.prepare(`
    INSERT INTO buyers(username) VALUES(?)
    ON CONFLICT(username) DO NOTHING
  `).bind(clean).run();
  return env.DB.prepare("SELECT id,username FROM buyers WHERE username=?")
    .bind(clean).first();
}

function money(n) {
  return new Intl.NumberFormat("id-ID").format(Number(n || 0));
}

function dateToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
  }).format(new Date());
}

function dateTimeNow() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date());
}

function validDate(s) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(s);
}

async function catalogueList(env, chatId, mode = "view") {
  const rows = await env.DB.prepare(
    "SELECT id,name,link FROM catalogues ORDER BY id"
  ).all();

  if (!rows.results.length) {
    await send(env, chatId, "📚 Catalogue masih kosong.\n\nKetik /addcatalogue untuk menambahkan catalogue.");
    return;
  }

  if (mode === "order") {
    const buttons = rows.results.map(r => [{
      text: `${r.id}. ${r.name}`,
      callback_data: `ordercat:${r.id}`,
    }]);
    await send(env, chatId, "🛒 Pilih catalogue untuk order baru:", {
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }

  let text = "📚 CATALOGUE JEJE\n\n";
  for (const r of rows.results) {
    text += `${r.id}. ${r.name}\n${r.link || "-"}\n\n`;
  }
  text += "Ketik /addcatalogue untuk tambah catalogue.";
  await send(env, chatId, text);
}

async function showOrder(env, chatId, orderId) {
  const row = await env.DB.prepare(`
    SELECT o.id,o.status,o.deadline,c.name catalogue,b.username,
           COALESCE((SELECT SUM(amount) FROM payments p WHERE p.order_id=o.id),0) amount
    FROM orders o
    JOIN buyers b ON b.id=o.buyer_id
    JOIN catalogues c ON c.id=o.catalogue_id
    WHERE o.id=?
  `).bind(orderId).first();

  if (!row) return send(env, chatId, "Order tidak ditemukan.");

  const statusMap = {
    PENDING: "⏳ BELUM BAYAR",
    UNPAID: "⏳ BELUM BAYAR",
    PAID: "💰 SUDAH BAYAR",
    DONE: "✅ DONE",
  };

  const text =
    `🧾 ORDER #${row.id}\n\n` +
    `👤 Buyer: ${row.username}\n` +
    `📚 Catalogue: ${row.name}\n` +
    `📅 Deadline: ${row.deadline || "-"}\n` +
    `💳 Status: ${statusMap[row.status] || row.status}\n` +
    `💰 Income: Rp${money(row.amount)}`;

  await send(env, chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💰 + INCOME", callback_data: `income:${row.id}` },
          { text: "⏳ Belum Bayar", callback_data: `unpaid:${row.id}` },
        ],
        [{ text: "✅ DONE", callback_data: `done:${row.id}` }],
      ],
    },
  });
}

async function today(env, chatId) {
  const day = dateToday();
  const orders = await env.DB.prepare(`
    SELECT o.id,o.status,o.deadline,c.name,b.username,
      COALESCE((SELECT SUM(amount) FROM payments p WHERE p.order_id=o.id),0) amount
    FROM orders o
    JOIN buyers b ON b.id=o.buyer_id
    JOIN catalogues c ON c.id=o.catalogue_id
    WHERE substr(o.created_at,1,10)=?
    ORDER BY o.id DESC
  `).bind(day).all();

  const income = await env.DB.prepare(`
    SELECT COALESCE(SUM(amount),0) total FROM payments WHERE substr(created_at,1,10)=?
  `).bind(day).first();

  let text = `📊 TODAY — ${day}\n\n`;
  if (!orders.results.length) {
    text += "Belum ada order hari ini.\n";
  } else {
    for (const o of orders.results) {
      const s = o.status === "DONE" ? "✅" : (o.status === "PAID" ? "💰" : "⏳");
      text += `${s} #${o.id} @${o.username.replace(/^@/, "")} — ${o.name} — Rp${money(o.amount)}\n`;
    }
  }
  text += `\n💵 Income hari ini: Rp${money(income.total)}`;
  await send(env, chatId, text);
}

async function finance(env, chatId) {
  const inc = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) total FROM payments").first();
  const exp = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) total FROM expenses").first();
  const unpaid = await env.DB.prepare(`
    SELECT COALESCE(SUM(x.amount),0) total FROM (
      SELECT o.id, COALESCE((SELECT SUM(amount) FROM payments p WHERE p.order_id=o.id),0) amount
      FROM orders o WHERE o.status IN ('PENDING','UNPAID')
    ) x
  `).first();

  const income = Number(inc.total || 0);
  const expense = Number(exp.total || 0);
  const piutang = Number(unpaid.total || 0);

  await send(env, chatId,
    `💰 KEUANGAN\n\n` +
    `💵 Total income: Rp${money(income)}\n` +
    `💸 Total pengeluaran/modal: Rp${money(expense)}\n` +
    `📈 Profit sederhana: Rp${money(income - expense)}\n` +
    `📌 Piutang tercatat: Rp${money(piutang)}\n\n` +
    `Untuk tambah pengeluaran: /modal`
  );
}

async function buyers(env, chatId) {
  const rows = await env.DB.prepare(`
    SELECT b.username, COUNT(o.id) orders,
      COALESCE(SUM((SELECT SUM(amount) FROM payments p WHERE p.order_id=o.id)),0) total
    FROM buyers b
    LEFT JOIN orders o ON o.buyer_id=b.id
    GROUP BY b.id
    ORDER BY b.id DESC
  `).all();

  if (!rows.results.length) return send(env, chatId, "👤 Belum ada buyer.");
  let text = "👤 BUYER\n\n";
  for (const r of rows.results) {
    text += `${r.username} — ${r.orders} order — Rp${money(r.total)}\n`;
  }
  await send(env, chatId, text);
}

async function deadlines(env, chatId) {
  const rows = await env.DB.prepare(`
    SELECT o.id,o.deadline,o.status,b.username,c.name
    FROM orders o
    JOIN buyers b ON b.id=o.buyer_id
    JOIN catalogues c ON c.id=o.catalogue_id
    WHERE o.deadline IS NOT NULL AND o.status <> 'DONE'
    ORDER BY o.deadline ASC
  `).all();

  if (!rows.results.length) return send(env, chatId, "📅 Tidak ada deadline aktif.");
  let text = "📅 DEADLINE AKTIF\n\n";
  for (const r of rows.results) {
    text += `#${r.id} — ${r.deadline}\n@${r.username.replace(/^@/,"")} — ${r.name}\n\n`;
  }
  await send(env, chatId, text);
}

async function handleMessage(update, env) {
  const msg = update.message;
  if (!msg?.chat?.id || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (String(msg.from?.id) !== String(env.OWNER_ID)) {
    await send(env, chatId, "⛔ JEJE adalah bot pribadi.");
    return;
  }

  if (text === "/start") {
    await send(env, chatId, `JEJE STORE siap. 🫶\n${dateTimeNow()}`, { reply_markup: MENU });
    return;
  }

  const session = await getSession(env, chatId);
  const stateData = session ? JSON.parse(session.data_json || "{}") : {};

  if (text === "/addcatalogue") {
    await setSession(env, chatId, "catalogue_add");
    await send(env, chatId, "📚 Kirim format:\nNama Catalogue | Link Telegram\n\nContoh:\nLove Letter | https://t.me/channel/123");
    return;
  }

  if (text === "/modal") {
    await setSession(env, chatId, "expense_add");
    await send(env, chatId, "💸 Kirim format:\nKeterangan | Nominal\n\nContoh:\nIklan | 50000");
    return;
  }

  if (stateData && session?.state === "catalogue_add") {
    const [name, link] = text.split("|").map(s => s?.trim());
    if (!name || !link) {
      await send(env, chatId, "Format salah. Pakai:\nNama Catalogue | Link Telegram");
      return;
    }
    await env.DB.prepare("INSERT INTO catalogues(name,link) VALUES(?,?)").bind(name, link).run();
    await clearSession(env, chatId);
    await send(env, chatId, "✅ Catalogue berhasil disimpan.");
    return;
  }

  if (session?.state === "expense_add") {
    const [description, amountText] = text.split("|").map(s => s?.trim());
    const amount = Number((amountText || "").replace(/[^\d]/g, ""));
    if (!description || !amount) {
      await send(env, chatId, "Format salah. Contoh:\nIklan | 50000");
      return;
    }
    await env.DB.prepare("INSERT INTO expenses(description,amount) VALUES(?,?)")
      .bind(description, amount).run();
    await clearSession(env, chatId);
    await send(env, chatId, `✅ Pengeluaran tersimpan: ${description} — Rp${money(amount)}`);
    return;
  }

  if (session?.state === "order_buyer") {
    const [username, deadline] = text.split("|").map(s => s?.trim());
    if (!username || !username.startsWith("@") || !deadline || !validDate(deadline)) {
      await send(env, chatId, "Format salah.\nPakai: @username | DD/MM/YYYY");
      return;
    }
    const buyer = await upsertBuyer(env, username);
    const order = await env.DB.prepare(`
      INSERT INTO orders(buyer_id,catalogue_id,status,deadline)
      VALUES(?,?, 'PENDING',?)
      RETURNING id
    `).bind(buyer.id, stateData.catalogue_id, deadline).first();
    await clearSession(env, chatId);
    await send(env, chatId, "✅ Order dibuat.");
    await showOrder(env, chatId, order.id);
    return;
  }

  if (session?.state === "income_add") {
    const amount = Number(text.replace(/[^\d]/g, ""));
    if (!amount) {
      await send(env, chatId, "Kirim nominal angka saja. Contoh: 150000");
      return;
    }
    await env.DB.prepare("INSERT INTO payments(order_id,amount) VALUES(?,?)")
      .bind(stateData.order_id, amount).run();
    await env.DB.prepare("UPDATE orders SET status='PAID' WHERE id=?")
      .bind(stateData.order_id).run();
    await clearSession(env, chatId);
    await send(env, chatId, `💰 Income Rp${money(amount)} tercatat.`);
    await showOrder(env, chatId, stateData.order_id);
    return;
  }

  if (text === "📚 Catalogue") return catalogueList(env, chatId);
  if (text === "🛒 Order Baru") return catalogueList(env, chatId, "order");
  if (text === "👤 Buyer") return buyers(env, chatId);
  if (text === "📊 Today") return today(env, chatId);
  if (text === "💰 Keuangan") return finance(env, chatId);
  if (text === "📅 Deadline") return deadlines(env, chatId);

  await send(env, chatId, "Pilih menu JEJE di bawah ya. 👇", { reply_markup: MENU });
}

async function handleCallback(update, env) {
  const q = update.callback_query;
  const chatId = q?.message?.chat?.id;
  if (!q || !chatId) return;
  if (!ownerOnly(update, env)) {
    await answerCallback(env, q.id, "Akses ditolak.");
    return;
  }

  const [action, rawId] = q.data.split(":");
  const id = Number(rawId);

  if (action === "ordercat") {
    const c = await env.DB.prepare("SELECT id,name FROM catalogues WHERE id=?").bind(id).first();
    if (!c) return answerCallback(env, q.id, "Catalogue tidak ditemukan.");
    await setSession(env, chatId, "order_buyer", { catalogue_id: c.id });
    await answerCallback(env, q.id);
    await send(env, chatId, `🛒 Catalogue: ${c.name}\n\nKirim:\n@username | DD/MM/YYYY`);
    return;
  }

  if (action === "income") {
    await setSession(env, chatId, "income_add", { order_id: id });
    await answerCallback(env, q.id);
    await send(env, chatId, "💰 Kirim nominal income. Contoh: 150000");
    return;
  }

  if (action === "unpaid") {
    await env.DB.prepare("UPDATE orders SET status='UNPAID' WHERE id=?").bind(id).run();
    await answerCallback(env, q.id, "Ditandai belum bayar.");
    await showOrder(env, chatId, id);
    return;
  }

  if (action === "done") {
    await env.DB.prepare("UPDATE orders SET status='DONE' WHERE id=?").bind(id).run();
    await answerCallback(env, q.id, "Order selesai.");
    await showOrder(env, chatId, id);
    return;
  }

  await answerCallback(env, q.id);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return new Response("JEJE STORE BOT — online");
      }

      if (request.method === "GET" && url.pathname === "/setup") {
        const key = url.searchParams.get("key");
        const webhookUrl = url.searchParams.get("url");
        if (!key || key !== env.SETUP_SECRET) return new Response("Unauthorized", { status: 401 });
        if (!webhookUrl) return new Response("Missing url", { status: 400 });
        const result = await tg(env, "setWebhook", { url: `${webhookUrl.replace(/\/$/, "")}/telegram` });
        return json(result);
      }

      if (request.method === "POST" && url.pathname === "/telegram") {
        const update = await request.json();
        if (update.message) await handleMessage(update, env);
        if (update.callback_query) await handleCallback(update, env);
        return new Response("OK");
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return new Response("JEJE error", { status: 500 });
    }
  },
};

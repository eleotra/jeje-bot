const TELEGRAM = "https://api.telegram.org";

async function tg(env, method, body) {
  const r = await fetch(`${TELEGRAM}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await r.json();
}

const j = (x) => JSON.stringify(x);

function ownerId(update) {
  return String(
    update?.message?.from?.id ??
    update?.callback_query?.from?.id ??
    ""
  );
}

function chatId(update) {
  return String(
    update?.message?.chat?.id ??
    update?.callback_query?.message?.chat?.id ??
    ""
  );
}

function isPrivate(update) {
  return (
    update?.message?.chat?.type === "private" ||
    update?.callback_query?.message?.chat?.type === "private"
  );
}

function money(n) {
  return new Intl.NumberFormat("id-ID").format(Number(n || 0));
}

function parseMoney(s) {
  const digits = String(s || "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : NaN;
}

function validDate(s) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(s);
}

function todayISO() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function displayDate(s) {
  if (!s) return "-";

  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);

  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function scope(owner, env, col = "owner_id") {
  return owner === String(env.OWNER_ID)
    ? `(${col} = ? OR ${col} IS NULL)`
    : `(${col} = ?)`;
}

async function getSession(env, key) {
  const r = await env.DB
    .prepare("SELECT state,data_json FROM sessions WHERE chat_id=?")
    .bind(key)
    .first();

  if (!r) return null;

  try {
    return {
      state: r.state,
      data: JSON.parse(r.data_json || "{}")
    };
  } catch {
    return {
      state: r.state,
      data: {}
    };
  }
}

async function setSession(env, key, state, data = {}) {
  await env.DB.prepare(`
    INSERT INTO sessions(chat_id,state,data_json,updated_at)
    VALUES(?,?,?,datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      state=excluded.state,
      data_json=excluded.data_json,
      updated_at=datetime('now')
  `)
    .bind(key, state, j(data))
    .run();
}

async function clearSession(env, key) {
  await env.DB
    .prepare("DELETE FROM sessions WHERE chat_id=?")
    .bind(key)
    .run();
}

function mainKeyboard() {
  return {
    keyboard: [
      [
        { text: "📚 Catalogue" },
        { text: "🛒 Order Baru" }
      ],
      [
        { text: "📋 Pesanan" },
        { text: "📅 Hari Ini" }
      ],
      [
        { text: "👥 Buyers" },
        { text: "💰 Keuangan" }
      ],
      [
        { text: "⏰ Deadline" },
        { text: "➕ Tambah Catalogue" }
      ],
      [
        { text: "🗑️ Hapus Catalogue" },
        { text: "💸 Tambah Modal" }
      ],
      [
        { text: "ℹ️ About" }
      ]
    ],
    resize_keyboard: true
  };
}

async function send(env, chat, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chat,
    text,
    parse_mode: "HTML",
    ...extra
  });
}

async function answerCallback(env, id, text = "") {
  return tg(env, "answerCallbackQuery", {
    callback_query_id: id,
    text
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function catalogueRows(env, owner) {
  return (
    await env.DB.prepare(`
      SELECT id,name,link,created_at
      FROM catalogues
      WHERE ${scope(owner, env)}
      ORDER BY id
    `)
      .bind(owner)
      .all()
  ).results || [];
}

async function confirmDeleteCatalogue(env, chat, owner, id) {
  const row = await env.DB.prepare(`
    SELECT id,name
    FROM catalogues
    WHERE id=? AND ${scope(owner, env)}
  `)
    .bind(id, owner)
    .first();

  if (!row) {
    return send(env, chat, "❌ Catalogue tidak ditemukan.");
  }

  return send(
    env,
    chat,
    `⚠️ Yakin mau menghapus catalogue <b>${escapeHtml(row.name)}</b>?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Ya, Hapus",
              callback_data: `confirmdel:${row.id}`
            },
            {
              text: "❌ Batal",
              callback_data: "cancel"
            }
          ]
        ]
      }
    }
  );
}

async function deleteCatalogue(env, chat, owner, id) {
  const row = await env.DB.prepare(`
    SELECT id,name
    FROM catalogues
    WHERE id=? AND ${scope(owner, env)}
  `)
    .bind(id, owner)
    .first();

  if (!row) {
    return send(env, chat, "❌ Catalogue tidak ditemukan.");
  }

  const used = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM orders
    WHERE catalogue_id=?
  `)
    .bind(id)
    .first();

  if (Number(used?.total || 0) > 0) {
    return send(
      env,
      chat,
      `⚠️ Catalogue <b>${escapeHtml(row.name)}</b> tidak bisa dihapus karena sudah digunakan pada pesanan.\n\nData lama tetap aman.`,
      { reply_markup: mainKeyboard() }
    );
  }

  await env.DB.prepare(`
    DELETE FROM catalogues
    WHERE id=? AND ${scope(owner, env)}
  `)
    .bind(id, owner)
    .run();

  return send(
    env,
    chat,
    `✅ Catalogue <b>${escapeHtml(row.name)}</b> berhasil dihapus.`,
    { reply_markup: mainKeyboard() }
  );
}

async function startOrder(env, chat, owner) {
  const rows = await catalogueRows(env, owner);

  if (!rows.length) {
    return send(
      env,
      chat,
      "🛒 Belum ada catalogue.\n\nTambahkan catalogue terlebih dahulu.",
      { reply_markup: mainKeyboard() }
    );
  }

  const buttons = rows.map((r) => [
    {
      text: `📚 ${r.name}`,
      callback_data: `ordercat:${r.id}`
    }
  ]);

  buttons.push([
    {
      text: "❌ Batal",
      callback_data: "cancel"
    }
  ]);

  return send(
    env,
    chat,
    "🛒 <b>ORDER BARU</b>\n\nPilih catalogue yang dibeli:",
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

async function chooseOrderCatalogue(env, chat, owner, catalogueId) {
  const row = await env.DB.prepare(`
    SELECT id,name,link
    FROM catalogues
    WHERE id=? AND ${scope(owner, env)}
  `)
    .bind(catalogueId, owner)
    .first();

  if (!row) {
    return send(env, chat, "❌ Catalogue tidak ditemukan.");
  }

  await setSession(env, chat, "ORDER_BUYER", {
    catalogueId: row.id,
    catalogueName: row.name
  });

  return send(
    env,
    chat,
    `📚 Catalogue: <b>${escapeHtml(row.name)}</b>\n\n` +
    `Sekarang masukkan <b>username buyer + nominal</b>.\n\n` +
    `Contoh:\n<code>@jpesek 5,000</code>\n\n` +
    `Tanpa tanda <code>|</code> ya.`
  );
}

async function saveBuyer(env, owner, username) {
  const existing = await env.DB.prepare(`
    SELECT id,username
    FROM buyers
    WHERE username=? AND ${scope(owner, env)}
    LIMIT 1
  `)
    .bind(username, owner)
    .first();

  if (existing) {
    return existing;
  }

  try {
    const result = await env.DB.prepare(`
      INSERT INTO buyers(username,owner_id)
      VALUES(?,?)
    `)
      .bind(username, owner)
      .run();

    return {
      id: result.meta.last_row_id,
      username
    };
  } catch (e) {
    // Database lama memiliki UNIQUE(username).
    // Kalau username sudah digunakan owner lain,
    // jangan pernah memakai data owner lain.
    return null;
  }
}

async function chooseOrderBuyer(
  env,
  chat,
  owner,
  catalogueId,
  username,
  amount
) {
  const buyer = await saveBuyer(env, owner, username);

  if (!buyer) {
    return send(
      env,
      chat,
      `❌ Username <b>${escapeHtml(username)}</b> sudah digunakan pada workspace lain.\n\n` +
      `Gunakan username buyer lain untuk sementara.`,
      { reply_markup: mainKeyboard() }
    );
  }

  await setSession(env, chat, "ORDER_DEADLINE", {
    catalogueId,
    buyerId: buyer.id,
    username,
    amount
  });

  return send(
    env,
    chat,
    `👤 Buyer: <b>${escapeHtml(username)}</b>\n` +
    `💰 Nominal: <b>Rp ${money(amount)}</b>\n\n` +
    `Sekarang masukkan <b>deadline</b>.\n\n` +
    `Format: <code>DD/MM/YYYY</code>\n` +
    `Contoh: <code>25/09/2026</code>`
  );
}

async function createOrder(
  env,
  chat,
  owner,
  catalogueId,
  buyerId,
  username,
  amount,
  deadline
) {
  await env.DB.prepare(`
    INSERT INTO orders(
      buyer_id,
      catalogue_id,
      status,
      deadline,
      amount_due,
      owner_id
    )
    VALUES(?,?,?,?,?,?)
  `)
    .bind(
      buyerId,
      catalogueId,
      "PENDING",
      deadline,
      amount,
      owner
    )
    .run();

  await clearSession(env, chat);

  return send(
    env,
    chat,
    `✅ <b>Order berhasil dicatat!</b>\n\n` +
    `👤 Buyer: <b>${escapeHtml(username)}</b>\n` +
    `📚 Catalogue: <b>${escapeHtml(
      (await env.DB.prepare(
        "SELECT name FROM catalogues WHERE id=?"
      ).bind(catalogueId).first())?.name || "-"
    )}</b>\n` +
    `📅 Order: <b>${displayDate(todayISO())}</b>\n` +
    `⏰ Deadline: <b>${escapeHtml(deadline)}</b>\n` +
    `💰 Nominal: <b>Rp ${money(amount)}</b>\n` +
    `📌 Status: <b>PENDING</b>`,
    {
      reply_markup: mainKeyboard()
    }
  );
}

async function orderRows(env, owner) {
  return (
    await env.DB.prepare(`
      SELECT
        o.id,
        o.status,
        o.deadline,
        o.amount_due,
        o.created_at,
        b.username,
        c.name AS catalogue_name,
        COALESCE(
          (SELECT SUM(p.amount)
           FROM payments p
           WHERE p.order_id=o.id),
          0
        ) AS paid
      FROM orders o
      JOIN buyers b ON b.id=o.buyer_id
      JOIN catalogues c ON c.id=o.catalogue_id
      WHERE ${scope(owner, env, "o.owner_id")}
      ORDER BY o.id DESC
    `)
      .bind(owner)
      .all()
  ).results || [];
}

function orderStatus(status, paid, due) {
  const totalPaid = Number(paid || 0);
  const totalDue = Number(due || 0);

  if (status === "DONE") return "✅ DONE";
  if (totalPaid >= totalDue && totalDue > 0) return "💰 PAID";
  if (status === "UNPAID") return "❌ UNPAID";
  if (totalPaid > 0) return "🟡 PARTIAL";
  return "⏳ PENDING";
}

async function showOrders(env, chat, owner) {
  const rows = await orderRows(env, owner);

  if (!rows.length) {
    return send(
      env,
      chat,
      "📋 <b>Belum ada pesanan.</b>",
      { reply_markup: mainKeyboard() }
    );
  }

  let text = "📋 <b>DAFTAR PESANAN</b>\n\n";

  rows.forEach((r) => {
    const paid = Number(r.paid || 0);
    const due = Number(r.amount_due || 0);
    const piutang = Math.max(due - paid, 0);

    text +=
      `<b>#${r.id} — ${escapeHtml(r.username)}</b>\n` +
      `📚 ${escapeHtml(r.catalogue_name)}\n` +
      `📅 Order: ${displayDate(r.created_at)}\n` +
      `⏰ Deadline: ${escapeHtml(r.deadline || "-")}\n` +
      `💰 Nominal: Rp ${money(due)}\n` +
      `💵 Masuk: Rp ${money(paid)}\n` +
      `🧾 Piutang: Rp ${money(piutang)}\n` +
      `📌 ${orderStatus(r.status, paid, due)}\n\n`;
  });

  return send(env, chat, text.trim(), {
    reply_markup: mainKeyboard()
  });
      }
async function markOrder(env, chat, owner, orderId, action) {
  const order = await env.DB.prepare(`
    SELECT
      o.id,
      o.status,
      o.amount_due,
      b.username
    FROM orders o
    JOIN buyers b ON b.id=o.buyer_id
    WHERE o.id=? AND ${scope(owner, env, "o.owner_id")}
  `)
    .bind(orderId, owner)
    .first();

  if (!order) {
    return send(env, chat, "❌ Pesanan tidak ditemukan.");
  }

  if (action === "DONE") {
    await env.DB.prepare(`
      UPDATE orders
      SET status='DONE'
      WHERE id=? AND ${scope(owner, env, "owner_id")}
    `)
      .bind(orderId, owner)
      .run();

    return send(
      env,
      chat,
      `✅ Order <b>#${order.id}</b> milik <b>${escapeHtml(order.username)}</b> ditandai <b>DONE</b>.`,
      { reply_markup: mainKeyboard() }
    );
  }

  if (action === "UNPAID") {
    await env.DB.prepare(`
      UPDATE orders
      SET status='UNPAID'
      WHERE id=? AND ${scope(owner, env, "owner_id")}
    `)
      .bind(orderId, owner)
      .run();

    return send(
      env,
      chat,
      `❌ Order <b>#${order.id}</b> milik <b>${escapeHtml(order.username)}</b> ditandai <b>UNPAID</b>.`,
      { reply_markup: mainKeyboard() }
    );
  }

  return send(env, chat, "❌ Aksi tidak dikenal.");
}

async function showOrderActions(env, chat, owner, orderId) {
  const order = await env.DB.prepare(`
    SELECT
      o.id,
      o.status,
      o.amount_due,
      o.deadline,
      o.created_at,
      b.username,
      c.name AS catalogue_name,
      COALESCE(
        (SELECT SUM(p.amount)
         FROM payments p
         WHERE p.order_id=o.id),
        0
      ) AS paid
    FROM orders o
    JOIN buyers b ON b.id=o.buyer_id
    JOIN catalogues c ON c.id=o.catalogue_id
    WHERE o.id=? AND ${scope(owner, env, "o.owner_id")}
  `)
    .bind(orderId, owner)
    .first();

  if (!order) {
    return send(env, chat, "❌ Pesanan tidak ditemukan.");
  }

  const paid = Number(order.paid || 0);
  const due = Number(order.amount_due || 0);

  return send(
    env,
    chat,
    `<b>ORDER #${order.id}</b>\n\n` +
    `👤 ${escapeHtml(order.username)}\n` +
    `📚 ${escapeHtml(order.catalogue_name)}\n` +
    `📅 Order: ${displayDate(order.created_at)}\n` +
    `⏰ Deadline: ${escapeHtml(order.deadline || "-")}\n` +
    `💰 Nominal: Rp ${money(due)}\n` +
    `💵 Masuk: Rp ${money(paid)}\n` +
    `📌 ${orderStatus(order.status, paid, due)}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "➕ INCOME",
              callback_data: `income:${order.id}`
            },
            {
              text: "❌ UNPAID",
              callback_data: `unpaid:${order.id}`
            }
          ],
          [
            {
              text: "✅ DONE",
              callback_data: `done:${order.id}`
            }
          ]
        ]
      }
    }
  );
}

async function incomePrompt(env, chat, owner, orderId) {
  const order = await env.DB.prepare(`
    SELECT o.id,o.amount_due,b.username
    FROM orders o
    JOIN buyers b ON b.id=o.buyer_id
    WHERE o.id=? AND ${scope(owner, env, "o.owner_id")}
  `)
    .bind(orderId, owner)
    .first();

  if (!order) {
    return send(env, chat, "❌ Pesanan tidak ditemukan.");
  }

  await setSession(env, chat, "INCOME_AMOUNT", {
    orderId: order.id
  });

  return send(
    env,
    chat,
    `➕ <b>INCOME</b>\n\n` +
    `Order: <b>#${order.id}</b>\n` +
    `Buyer: <b>${escapeHtml(order.username)}</b>\n` +
    `Nominal order: <b>Rp ${money(order.amount_due)}</b>\n\n` +
    `Masukkan nominal uang yang benar-benar masuk.\n\n` +
    `Contoh: <code>5,000</code>`
  );
}

async function saveIncome(env, chat, owner, orderId, amount) {
  const order = await env.DB.prepare(`
    SELECT id,amount_due
    FROM orders
    WHERE id=? AND ${scope(owner, env, "owner_id")}
  `)
    .bind(orderId, owner)
    .first();

  if (!order) {
    return send(env, chat, "❌ Pesanan tidak ditemukan.");
  }

  await env.DB.prepare(`
    INSERT INTO payments(order_id,amount)
    VALUES(?,?)
  `)
    .bind(orderId, amount)
    .run();

  const paid = await env.DB.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total
    FROM payments
    WHERE order_id=?
  `)
    .bind(orderId)
    .first();

  const totalPaid = Number(paid?.total || 0);
  const totalDue = Number(order.amount_due || 0);

  const newStatus =
    totalPaid >= totalDue && totalDue > 0
      ? "PAID"
      : "PENDING";

  await env.DB.prepare(`
    UPDATE orders
    SET status=?
    WHERE id=? AND ${scope(owner, env, "owner_id")}
  `)
    .bind(newStatus, orderId, owner)
    .run();

  await clearSession(env, chat);

  return send(
    env,
    chat,
    `✅ <b>Income berhasil dicatat!</b>\n\n` +
    `💰 Masuk: <b>Rp ${money(amount)}</b>\n` +
    `💵 Total masuk order: <b>Rp ${money(totalPaid)}</b>\n` +
    `🧾 Sisa piutang: <b>Rp ${money(
      Math.max(totalDue - totalPaid, 0)
    )}</b>\n` +
    `📌 Status: <b>${newStatus}</b>`,
    {
      reply_markup: mainKeyboard()
    }
  );
}

async function todayReport(env, chat, owner) {
  const date = todayISO();

  const rows = (
    await env.DB.prepare(`
      SELECT
        o.id,
        o.status,
        o.deadline,
        o.amount_due,
        o.created_at,
        b.username,
        c.name AS catalogue_name,
        COALESCE(
          (SELECT SUM(p.amount)
           FROM payments p
           WHERE p.order_id=o.id),
          0
        ) AS paid
      FROM orders o
      JOIN buyers b ON b.id=o.buyer_id
      JOIN catalogues c ON c.id=o.catalogue_id
      WHERE substr(o.created_at,1,10)=?
        AND ${scope(owner, env, "o.owner_id")}
      ORDER BY o.id DESC
    `)
      .bind(date, owner)
      .all()
  ).results || [];

  const income = (
    await env.DB.prepare(`
      SELECT COALESCE(SUM(p.amount),0) AS total
      FROM payments p
      JOIN orders o ON o.id=p.order_id
      WHERE substr(p.created_at,1,10)=?
        AND ${scope(owner, env, "o.owner_id")}
    `)
      .bind(date, owner)
      .first()
  )?.total || 0;

  if (!rows.length) {
    return send(
      env,
      chat,
      `📅 <b>REKAP HARI INI</b>\n\n` +
      `Tanggal: <b>${displayDate(date)}</b>\n\n` +
      `Belum ada order hari ini.\n\n` +
      `💰 Income hari ini: <b>Rp ${money(income)}</b>`,
      { reply_markup: mainKeyboard() }
    );
  }

  let text =
    `📅 <b>REKAP HARI INI</b>\n` +
    `Tanggal: <b>${displayDate(date)}</b>\n\n`;

  rows.forEach((r) => {
    text +=
      `<b>#${r.id} — ${escapeHtml(r.username)}</b>\n` +
      `📚 ${escapeHtml(r.catalogue_name)}\n` +
      `⏰ ${escapeHtml(r.deadline || "-")}\n` +
      `💰 Rp ${money(r.amount_due)}\n` +
      `📌 ${orderStatus(r.status, r.paid, r.amount_due)}\n\n`;
  });

  text += `💵 <b>Total income hari ini: Rp ${money(income)}</b>`;

  return send(env, chat, text, {
    reply_markup: mainKeyboard()
  });
}

async function buyersReport(env, chat, owner) {
  const rows = (
    await env.DB.prepare(`
      SELECT
        b.id,
        b.username,
        COUNT(o.id) AS total_orders,
        COALESCE(SUM(o.amount_due),0) AS total_nominal
      FROM buyers b
      LEFT JOIN orders o ON o.buyer_id=b.id
        AND ${scope(owner, env, "o.owner_id")}
      WHERE ${scope(owner, env, "b.owner_id")}
      GROUP BY b.id,b.username
      ORDER BY b.id DESC
    `)
      .bind(owner, owner)
      .all()
  ).results || [];

  if (!rows.length) {
    return send(
      env,
      chat,
      "👥 <b>Belum ada buyer.</b>",
      { reply_markup: mainKeyboard() }
    );
  }

  let text = "👥 <b>BUYERS</b>\n\n";

  rows.forEach((r, i) => {
    text +=
      `<b>${i + 1}. ${escapeHtml(r.username)}</b>\n` +
      `🛒 Order: ${r.total_orders}\n` +
      `💰 Total nominal: Rp ${money(r.total_nominal)}\n\n`;
  });

  return send(env, chat, text.trim(), {
    reply_markup: mainKeyboard()
  });
}

async function handleMessage(env, update) {
  const chat = chatId(update);
  const owner = ownerId(update);
  const text = String(update?.message?.text || "").trim();

  if (!chat || !owner) return;

  // JEJE hanya bekerja di private chat
  if (!isPrivate(update)) {
    return send(
      env,
      chat,
      "🔒 JEJE STORE hanya bisa digunakan melalui private chat."
    );
  }

  // START / MENU / HAI
  if (
    text === "/start" ||
    text === "/menu" ||
    text.toLowerCase() === "hai"
  ) {
    await clearSession(env, chat);

    return send(
      env,
      chat,
      `👋 <b>WELCOME TO JEJE STORE</b>\n\n` +
      `Bot pribadi untuk mencatat catalogue, order, income, buyer, modal, piutang, dan deadline kamu.\n\n` +
      `✨ Semua data workspace ini terpisah berdasarkan akun Telegram masing-masing.\n\n` +
      `<i>Credit by @jpesek — @eyshies</i>`,
      { reply_markup: mainKeyboard() }
    );
  }

  // BATAL
  if (text === "❌ Batal") {
    await clearSession(env, chat);

    return send(
      env,
      chat,
      "❌ Proses dibatalkan.",
      { reply_markup: mainKeyboard() }
    );
  }

  /*
   * TOMBOL MENU UTAMA
   */
  if (text === "📚 Catalogue") {
    await clearSession(env, chat);

    const rows = await catalogueRows(env, owner);

    if (!rows.length) {
      return send(
        env,
        chat,
        "📚 <b>CATALOGUE</b>\n\nBelum ada catalogue.\n\nTekan <b>➕ Tambah Catalogue</b> untuk membuat catalogue pertama.",
        { reply_markup: mainKeyboard() }
      );
    }

    let msg = "📚 <b>CATALOGUE</b>\n\n";

    rows.forEach((r, i) => {
      msg +=
        `<b>${i + 1}. ${escapeHtml(r.name)}</b>\n` +
        `🔗 ${escapeHtml(r.link)}\n\n`;
    });

    return send(
      env,
      chat,
      msg.trim(),
      { reply_markup: mainKeyboard() }
    );
  }

  if (text === "➕ Tambah Catalogue") {
    await setSession(env, chat, "CATALOGUE_NAME");

    return send(
      env,
      chat,
      `➕ <b>TAMBAH CATALOGUE</b>\n\n` +
      `Masukkan <b>nama catalogue</b> terlebih dahulu.\n\n` +
      `Contoh:\n<code>Catalogue September</code>`
    );
  }

  if (text === "🗑️ Hapus Catalogue") {
    await clearSession(env, chat);

    const rows = await catalogueRows(env, owner);

    if (!rows.length) {
      return send(
        env,
        chat,
        "🗑️ Belum ada catalogue yang bisa dihapus.",
        { reply_markup: mainKeyboard() }
      );
    }

    const buttons = rows.map((r) => [
      {
        text: `🗑️ ${r.name}`,
        callback_data: `delcat:${r.id}`
      }
    ]);

    buttons.push([
      {
        text: "❌ Batal",
        callback_data: "cancel"
      }
    ]);

    return send(
      env,
      chat,
      "🗑️ <b>HAPUS CATALOGUE</b>\n\nPilih catalogue yang ingin dihapus:",
      {
        reply_markup: {
          inline_keyboard: buttons
        }
      }
    );
  }

  if (text === "🛒 Order Baru") {
    await clearSession(env, chat);
    return startOrder(env, chat, owner);
  }

  if (text === "📋 Pesanan") {
    await clearSession(env, chat);

    const rows = await orderRows(env, owner);

    if (!rows.length) {
      return send(
        env,
        chat,
        "📋 <b>PESANAN</b>\n\nBelum ada pesanan.",
        { reply_markup: mainKeyboard() }
      );
    }

    let msg = "📋 <b>DAFTAR PESANAN</b>\n\n";
    const buttons = [];

    rows.forEach((r) => {
      const paid = Number(r.paid || 0);
      const due = Number(r.amount_due || 0);
      const piutang = Math.max(due - paid, 0);

      msg +=
        `<b>#${r.id} — ${escapeHtml(r.username)}</b>\n` +
        `📚 ${escapeHtml(r.catalogue_name)}\n` +
        `📅 Order: ${displayDate(r.created_at)}\n` +
        `⏰ Deadline: ${escapeHtml(r.deadline || "-")}\n` +
        `💰 Nominal: Rp ${money(due)}\n` +
        `💵 Masuk: Rp ${money(paid)}\n` +
        `🧾 Piutang: Rp ${money(piutang)}\n` +
        `📌 ${orderStatus(r.status, paid, due)}\n\n`;

      buttons.push([
        {
          text: `🔎 Order #${r.id} — ${r.username}`,
          callback_data: `order:${r.id}`
        }
      ]);
    });

    return send(
      env,
      chat,
      msg.trim(),
      {
        reply_markup: {
          inline_keyboard: buttons
        }
      }
    );
  }

  if (text === "📅 Hari Ini") {
    await clearSession(env, chat);
    return todayReport(env, chat, owner);
  }

  if (text === "👥 Buyers") {
    await clearSession(env, chat);
    return buyersReport(env, chat, owner);
  }

  if (text === "💰 Keuangan") {
    await clearSession(env, chat);

    const income = await env.DB.prepare(`
      SELECT COALESCE(SUM(p.amount),0) AS total
      FROM payments p
      JOIN orders o ON o.id=p.order_id
      WHERE ${scope(owner, env, "o.owner_id")}
    `)
      .bind(owner)
      .first();

    const expense = await env.DB.prepare(`
      SELECT COALESCE(SUM(amount),0) AS total
      FROM expenses
      WHERE ${scope(owner, env)}
    `)
      .bind(owner)
      .first();

    const piutang = await env.DB.prepare(`
      SELECT COALESCE(
        SUM(
          CASE
            WHEN o.amount_due - COALESCE(
              (SELECT SUM(p.amount)
               FROM payments p
               WHERE p.order_id=o.id),
              0
            ) > 0
            THEN o.amount_due - COALESCE(
              (SELECT SUM(p.amount)
               FROM payments p
               WHERE p.order_id=o.id),
              0
            )
            ELSE 0
          END
        ),
        0
      ) AS total
      FROM orders o
      WHERE ${scope(owner, env, "o.owner_id")}
        AND o.status != 'DONE'
    `)
      .bind(owner)
      .first();

    const totalIncome = Number(income?.total || 0);
    const totalExpense = Number(expense?.total || 0);
    const totalPiutang = Number(piutang?.total || 0);
    const profit = totalIncome - totalExpense;

    return send(
      env,
      chat,
      `💰 <b>KEUANGAN</b>\n\n` +
      `💵 Total Income: <b>Rp ${money(totalIncome)}</b>\n` +
      `💸 Total Modal: <b>Rp ${money(totalExpense)}</b>\n` +
      `📈 Profit: <b>Rp ${money(profit)}</b>\n` +
      `🧾 Piutang: <b>Rp ${money(totalPiutang)}</b>`,
      { reply_markup: mainKeyboard() }
    );
  }

  if (text === "💸 Tambah Modal") {
    await setSession(env, chat, "EXPENSE_DESC");

    return send(
      env,
      chat,
      `💸 <b>TAMBAH MODAL</b>\n\n` +
      `Masukkan keterangan modal.\n\n` +
      `Contoh:\n<code>Beli bahan</code>`
    );
  }

  if (text === "⏰ Deadline") {
    await clearSession(env, chat);

    const rows = (
      await env.DB.prepare(`
        SELECT
          o.id,
          o.deadline,
          o.status,
          o.amount_due,
          b.username,
          c.name AS catalogue_name
        FROM orders o
        JOIN buyers b ON b.id=o.buyer_id
        JOIN catalogues c ON c.id=o.catalogue_id
        WHERE ${scope(owner, env, "o.owner_id")}
          AND o.status != 'DONE'
          AND o.deadline IS NOT NULL
        ORDER BY o.deadline
      `)
        .bind(owner)
        .all()
    ).results || [];

    if (!rows.length) {
      return send(
        env,
        chat,
        "⏰ <b>DEADLINE</b>\n\nTidak ada order dengan deadline aktif.",
        { reply_markup: mainKeyboard() }
      );
    }

    let msg = "⏰ <b>DEADLINE ORDER</b>\n\n";

    rows.forEach((r) => {
      msg +=
        `<b>#${r.id} — ${escapeHtml(r.username)}</b>\n` +
        `📚 ${escapeHtml(r.catalogue_name)}\n` +
        `⏰ Deadline: <b>${escapeHtml(r.deadline)}</b>\n` +
        `💰 Rp ${money(r.amount_due)}\n` +
        `📌 ${escapeHtml(r.status)}\n\n`;
    });

    return send(
      env,
      chat,
      msg.trim(),
      { reply_markup: mainKeyboard() }
    );
  }

  if (text === "ℹ️ About") {
    await clearSession(env, chat);

    return send(
      env,
      chat,
      `ℹ️ <b>ABOUT JEJE STORE</b>\n\n` +
      `JEJE adalah bot pribadi untuk membantu mencatat dan mengelola orderan.\n\n` +
      `📚 Catalogue\n` +
      `🛒 Order\n` +
      `👥 Buyer\n` +
      `💰 Income\n` +
      `💸 Modal\n` +
      `🧾 Piutang\n` +
      `⏰ Deadline\n\n` +
      `<i>Credit by @jpesek — @eyshies</i>`,
      { reply_markup: mainKeyboard() }
    );
  }

  /*
   * PROSES INPUT BERDASARKAN SESSION
   */
  const session = await getSession(env, chat);

  if (!session) {
    return send(
      env,
      chat,
      "🤔 Aku belum tahu mau melakukan apa.\n\nGunakan menu di bawah ya.",
      { reply_markup: mainKeyboard() }
    );
  }

  if (session.state === "CATALOGUE_NAME") {
    const name = text.trim();

    if (!name) {
      return send(env, chat, "❌ Nama catalogue tidak boleh kosong.");
    }

    await setSession(env, chat, "CATALOGUE_LINK", { name });

    return send(
      env,
      chat,
      `📚 Nama catalogue: <b>${escapeHtml(name)}</b>\n\n` +
      `Sekarang masukkan <b>link postingan Telegram</b>.\n\n` +
      `Contoh:\n<code>https://t.me/namachannel/123</code>`
    );
  }

  if (session.state === "CATALOGUE_LINK") {
    const link = text.trim();

    if (!/^https?:\/\/\S+$/i.test(link)) {
      return send(
        env,
        chat,
        "❌ Link tidak valid.\n\nMasukkan link Telegram yang diawali <code>https://</code>."
      );
    }

    await env.DB.prepare(`
      INSERT INTO catalogues(name,link,owner_id)
      VALUES(?,?,?)
    `)
      .bind(session.data.name, link, owner)
      .run();

    await clearSession(env, chat);

    return send(
      env,
      chat,
      `✅ <b>Catalogue berhasil ditambahkan!</b>\n\n` +
      `📚 Nama: <b>${escapeHtml(session.data.name)}</b>\n` +
      `🔗 ${escapeHtml(link)}`,
      { reply_markup: mainKeyboard() }
    );
  }

  if (session.state === "ORDER_BUYER") {
    const match = text.match(/^(@[A-Za-z0-9_]+)\s+(.+)$/);

    if (!match) {
      return send(
        env,
        chat,
        `❌ Format salah.\n\nGunakan:\n<code>@jpesek 5,000</code>`
      );
    }

    const username = match[1];
    const amount = parseMoney(match[2]);

    if (!Number.isFinite(amount) || amount <= 0) {
      return send(
        env,
        chat,
        "❌ Nominal tidak valid.\n\nContoh: <code>@jpesek 5,000</code>"
      );
    }

    return chooseOrderBuyer(
      env,
      chat,
      owner,
      session.data.catalogueId,
      username,
      amount
    );
  }

  if (session.state === "ORDER_DEADLINE") {
    const deadline = text.trim();

    if (!validDate(deadline)) {
      return send(
        env,
        chat,
        "❌ Format tanggal salah.\n\nGunakan format:\n<code>DD/MM/YYYY</code>"
      );
    }

    return createOrder(
      env,
      chat,
      owner,
      session.data.catalogueId,
      session.data.buyerId,
      session.data.username,
      session.data.amount,
      deadline
    );
  }

  if (session.state === "INCOME_AMOUNT") {
    const amount = parseMoney(text);

    if (!Number.isFinite(amount) || amount <= 0) {
      return send(
        env,
        chat,
        "❌ Nominal income tidak valid.\n\nContoh: <code>5,000</code>"
      );
    }

    return saveIncome(
      env,
      chat,
      owner,
      session.data.orderId,
      amount
    );
  }

  if (session.state === "EXPENSE_DESC") {
    const description = text.trim();

    if (!description) {
      return send(
        env,
        chat,
        "❌ Keterangan modal tidak boleh kosong."
      );
    }

    await setSession(
      env,
      chat,
      "EXPENSE_AMOUNT",
      { description }
    );

    return send(
      env,
      chat,
      `💸 Keterangan: <b>${escapeHtml(description)}</b>\n\n` +
      `Sekarang masukkan nominal modal.\n\n` +
      `Contoh:\n<code>50,000</code>`
    );
  }

  if (session.state === "EXPENSE_AMOUNT") {
    const amount = parseMoney(text);

    if (!Number.isFinite(amount) || amount <= 0) {
      return send(
        env,
        chat,
        "❌ Nominal modal tidak valid.\n\nContoh: <code>50,000</code>"
      );
    }

    await env.DB.prepare(`
      INSERT INTO expenses(description,amount,owner_id)
      VALUES(?,?,?)
    `)
      .bind(session.data.description, amount, owner)
      .run();

    await clearSession(env, chat);

    return send(
      env,
      chat,
      `✅ <b>Modal berhasil dicatat!</b>\n\n` +
      `📝 ${escapeHtml(session.data.description)}\n` +
      `💸 Rp ${money(amount)}`,
      { reply_markup: mainKeyboard() }
    );
  }

  await clearSession(env, chat);

  return send(
    env,
    chat,
    "⚠️ Sesi sebelumnya sudah tidak dikenali.\n\nSilakan pilih menu lagi.",
    { reply_markup: mainKeyboard() }
  );
}


async function handleCallback(env, update) {
  const chat = chatId(update);
  const owner = ownerId(update);
  const data = String(update?.callback_query?.data || "");
  const callbackId = update?.callback_query?.id;

  if (!chat || !owner) return;

  if (!isPrivate(update)) {
    await answerCallback(env, callbackId, "Gunakan JEJE di private chat.");
    return;
  }

  await answerCallback(env, callbackId);

  if (data === "cancel") {
    await clearSession(env, chat);

    return send(
      env,
      chat,
      "❌ Dibatalkan.",
      { reply_markup: mainKeyboard() }
    );
  }

  if (data.startsWith("ordercat:")) {
    const id = Number(data.split(":")[1]);

    if (!Number.isFinite(id)) return;

    return chooseOrderCatalogue(
      env,
      chat,
      owner,
      id
    );
  }

  if (data.startsWith("delcat:")) {
    const id = Number(data.split(":")[1]);

    if (!Number.isFinite(id)) return;

    return confirmDeleteCatalogue(
      env,
      chat,
      owner,
      id
    );
  }

  if (data.startsWith("confirmdel:")) {
    const id = Number(data.split(":")[1]);

    if (!Number.isFinite(id)) return;

    return deleteCatalogue(
      env,
      chat,
      owner,
      id
    );
  }

  if (data.startsWith("order:")) {
    const id = Number(data.split(":")[1]);

    if (!Number.isFinite(id)) return;

    return showOrderActions(
      env,
      chat,
      owner,
      id
    );
  }

  if (data.startsWith("income:")) {
    const id = Number(data.split(":")[1]);

    if (!Number.isFinite(id)) return;

    return incomePrompt(
      env,
      chat,
      owner,
      id
    );
  }

  if (data.startsWith("done:")) {
    const id = Number(data.split(":")[1]);

    if (!Number.isFinite(id)) return;

    return markOrder(
      env,
      chat,
      owner,
      id,
      "DONE"
    );
  }

  if (data.startsWith("unpaid:")) {
    const id = Number(data.split(":")[1]);

    if (!Number.isFinite(id)) return;

    return markOrder(
      env,
      chat,
      owner,
      id,
      "UNPAID"
    );
  }

  return send(
    env,
    chat,
    "⚠️ Tombol tersebut sudah tidak aktif.",
    { reply_markup: mainKeyboard() }
  );
        }

async function setupWebhook(env, request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");

  if (!secret || secret !== env.SETUP_SECRET) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Unauthorized"
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }

  const webhookUrl = `${url.origin}/webhook`;

  const result = await tg(env, "setWebhook", {
    url: webhookUrl,
    allowed_updates: [
      "message",
      "callback_query"
    ]
  });

  return new Response(
    JSON.stringify(result),
    {
      headers: {
        "content-type": "application/json"
      }
    }
  );
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/setup") {
        return setupWebhook(env, request);
      }

      if (url.pathname === "/") {
        return new Response(
          "JEJE STORE BOT is running.",
          {
            headers: {
              "content-type": "text/plain"
            }
          }
        );
      }

      if (url.pathname !== "/webhook") {
        return new Response("Not Found", {
          status: 404
        });
      }

      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405
        });
      }

      const update = await request.json();

      if (update.callback_query) {
        await handleCallback(env, update);
      } else if (update.message) {
        await handleMessage(env, update);
      }

      return new Response("OK");
    } catch (error) {
      console.error(error);

      return new Response(
        JSON.stringify({
          ok: false,
          error: String(error?.message || error)
        }),
        {
          status: 500,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }
  }
};

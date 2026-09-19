
import os, sqlite3
from datetime import datetime, date
from flask import Flask, request, jsonify
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, MessageHandler, ContextTypes, filters

TOKEN=os.getenv("BOT_TOKEN","")
OWNER_ID=int(os.getenv("OWNER_ID","0"))
DB_PATH=os.getenv("DB_PATH","jeje.db")
SECRET=os.getenv("WEBHOOK_SECRET","change-me")
BASE_URL=os.getenv("RENDER_EXTERNAL_URL","").rstrip("/")
app=Flask(__name__)

def con(): 
    c=sqlite3.connect(DB_PATH); c.row_factory=sqlite3.Row; return c
def init():
    c=con()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS catalogue(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,link TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS buyers(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE,created_at TEXT);
    CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT,buyer_id INTEGER,catalogue_id INTEGER,status TEXT DEFAULT 'PENDING',deadline TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER,amount INTEGER,created_at TEXT);
    CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT,description TEXT,amount INTEGER,created_at TEXT);
    """); c.commit(); c.close()
init()

def ok(u): return u.effective_user and u.effective_user.id==OWNER_ID
def rp(n): return "Rp{:,.0f}".format(n).replace(",",".")

def menu():
    return InlineKeyboardMarkup([
      [InlineKeyboardButton("📚 Catalogue",callback_data="catalogue"),InlineKeyboardButton("🛒 Order Baru",callback_data="new")],
      [InlineKeyboardButton("👥 Buyer",callback_data="buyers"),InlineKeyboardButton("📊 Today",callback_data="today")],
      [InlineKeyboardButton("💰 Keuangan",callback_data="money"),InlineKeyboardButton("⏰ Deadline",callback_data="deadline")]
    ])

async def start(u,ctx):
    if ok(u): await u.message.reply_text("💿 JEJE STORE\n\nPersonal Order Manager",reply_markup=menu())

async def cb(u,ctx):
    if not ok(u): return
    q=u.callback_query; await q.answer(); d=q.data
    if d=="home":
        await q.edit_message_text("💿 JEJE STORE\n\nPilih menu:",reply_markup=menu()); return
    if d=="catalogue":
        c=con(); rows=c.execute("SELECT * FROM catalogue ORDER BY id").fetchall(); c.close()
        text="📚 CATALOGUE\n\n"; kb=[]
        for r in rows:
            text+=f"{r['id']}. {r['name']}\n"
            kb.append([InlineKeyboardButton(f"🔗 {r['id']} — {r['name']}",url=r['link'])])
        if not rows: text+="Belum ada catalogue.\n"
        kb.append([InlineKeyboardButton("➕ Tambah Catalogue",callback_data="addcat")])
        kb.append([InlineKeyboardButton("⬅️ Menu",callback_data="home")])
        await q.edit_message_text(text,reply_markup=InlineKeyboardMarkup(kb)); return
    if d=="addcat":
        ctx.user_data["state"]="cat"
        await q.edit_message_text("Kirim:\nNama Catalogue | Link Telegram\n\nContoh:\nFlipbook | https://t.me/channel/123"); return
    if d=="new":
        c=con(); rows=c.execute("SELECT * FROM catalogue ORDER BY id").fetchall(); c.close()
        if not rows: await q.edit_message_text("Catalogue kosong. Tambahkan dulu."); return
        await q.edit_message_text("🛒 Pilih catalogue:",reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton(f"{r['id']}. {r['name']}",callback_data=f"pick:{r['id']}")] for r in rows]+[[InlineKeyboardButton("⬅️ Menu",callback_data="home")]])); return
    if d.startswith("pick:"):
        ctx.user_data["state"]="order"; ctx.user_data["catid"]=int(d.split(":")[1])
        await q.edit_message_text("Kirim:\n@buyer | DD/MM/YYYY\n\nContoh:\n@abc | 21/09/2026"); return
    if d.startswith("ord:"):
        oid=int(d.split(":")[1]); c=con()
        r=c.execute("""SELECT o.*,b.username,c.name,COALESCE(SUM(p.amount),0) paid
          FROM orders o JOIN buyers b ON b.id=o.buyer_id JOIN catalogue c ON c.id=o.catalogue_id
          LEFT JOIN payments p ON p.order_id=o.id WHERE o.id=? GROUP BY o.id""",(oid,)).fetchone(); c.close()
        kb=[[InlineKeyboardButton("💰 + INCOME",callback_data=f"inc:{oid}")],
            [InlineKeyboardButton("⏳ Belum Bayar",callback_data=f"unpaid:{oid}")],
            [InlineKeyboardButton("✅ DONE",callback_data=f"done:{oid}")]]
        await q.edit_message_text(f"📦 ORDER #{oid}\n\n{r['username']}\n{r['name']}\nStatus: {r['status']}\nDeadline: {r['deadline'] or '-'}\nIncome: {rp(r['paid'])}",reply_markup=InlineKeyboardMarkup(kb)); return
    if d.startswith("inc:"):
        ctx.user_data["state"]="income"; ctx.user_data["oid"]=int(d.split(":")[1])
        await q.edit_message_text("💰 Kirim nominal income, contoh: 150000"); return
    if d.startswith("done:"):
        oid=int(d.split(":")[1]); c=con(); c.execute("UPDATE orders SET status='DONE' WHERE id=?",(oid,)); c.commit(); c.close()
        await q.edit_message_text(f"✅ ORDER #{oid} DONE"); return
    if d.startswith("unpaid:"):
        await q.edit_message_text("⏳ Dicatat sebagai belum bayar/piutang pada order tersebut."); return
    if d=="buyers":
        c=con(); rows=c.execute("""SELECT b.username,COUNT(o.id) n,COALESCE(SUM(p.amount),0) paid
        FROM buyers b LEFT JOIN orders o ON o.buyer_id=b.id LEFT JOIN payments p ON p.order_id=o.id
        GROUP BY b.id ORDER BY b.username""").fetchall(); c.close()
        text="👥 BUYERS\n\n"+("\n".join(f"• {r['username']} — {r['n']} order — {rp(r['paid'])}" for r in rows) or "Belum ada buyer.")
        await q.edit_message_text(text,reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Menu",callback_data="home")]])); return
    if d=="today":
        t=date.today().isoformat(); c=con()
        rows=c.execute("""SELECT o.id,b.username,c.name,o.status,COALESCE(SUM(p.amount),0) paid
        FROM orders o JOIN buyers b ON b.id=o.buyer_id JOIN catalogue c ON c.id=o.catalogue_id
        LEFT JOIN payments p ON p.order_id=o.id WHERE substr(o.created_at,1,10)=?
        GROUP BY o.id ORDER BY o.id DESC""",(t,)).fetchall()
        total=c.execute("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE substr(created_at,1,10)=?",(t,)).fetchone()["n"]; c.close()
        text=f"📊 TODAY — {t}\n\n"+("\n".join(f"• #{r['id']} {r['username']} — {r['name']} — {r['status']} — {rp(r['paid'])}" for r in rows) or "Belum ada order.")+f"\n\n💰 Income: {rp(total)}"
        await q.edit_message_text(text,reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Menu",callback_data="home")]])); return
    if d=="money":
        c=con(); inc=c.execute("SELECT COALESCE(SUM(amount),0)n FROM payments").fetchone()["n"]; exp=c.execute("SELECT COALESCE(SUM(amount),0)n FROM expenses").fetchone()["n"]; c.close()
        await q.edit_message_text(f"💰 KEUANGAN\n\n💵 Income: {rp(inc)}\n💸 Modal: {rp(exp)}\n✨ Profit: {rp(inc-exp)}\n\n➕ Modal via /modal",reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Menu",callback_data="home")]])); return
    if d=="deadline":
        c=con(); rows=c.execute("""SELECT o.id,b.username,c.name,o.deadline,o.status FROM orders o
        JOIN buyers b ON b.id=o.buyer_id JOIN catalogue c ON c.id=o.catalogue_id
        WHERE o.status NOT IN ('DONE','CANCEL') AND o.deadline IS NOT NULL ORDER BY o.deadline""").fetchall(); c.close()
        text="⏰ DEADLINE\n\n"+("\n".join(f"#{r['id']} {r['username']} — {r['name']} — {r['deadline']} — {r['status']}" for r in rows) or "Tidak ada deadline aktif.")
        await q.edit_message_text(text,reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Menu",callback_data="home")]]))

async def text(u,ctx):
    if not ok(u): return
    s=ctx.user_data.get("state"); x=(u.message.text or "").strip()
    if s=="cat":
        try:
            name,link=[z.strip() for z in x.split("|",1)]
            c=con(); c.execute("INSERT INTO catalogue(name,link,created_at) VALUES(?,?,?)",(name,link,datetime.now().isoformat())); c.commit(); c.close(); ctx.user_data.clear()
            await u.message.reply_text("✅ Catalogue tersimpan.",reply_markup=menu())
        except: await u.message.reply_text("Format salah. Nama | Link")
    elif s=="order":
        try:
            user,ds=[z.strip() for z in x.split("|",1)]; cid=ctx.user_data["catid"]
            d=datetime.strptime(ds,"%d/%m/%Y").date().isoformat()
            c=con(); c.execute("INSERT OR IGNORE INTO buyers(username,created_at) VALUES(?,?)",(user,datetime.now().isoformat()))
            bid=c.execute("SELECT id FROM buyers WHERE username=?",(user,)).fetchone()["id"]
            cur=c.execute("INSERT INTO orders(buyer_id,catalogue_id,deadline,created_at) VALUES(?,?,?,?)",(bid,cid,d,datetime.now().isoformat())); oid=cur.lastrowid
            c.commit(); c.close(); ctx.user_data.clear()
            await u.message.reply_text(f"🛒 ORDER #{oid} tersimpan.",reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("📦 Kelola Order",callback_data=f"ord:{oid}")]]))
        except: await u.message.reply_text("Format salah. Contoh: @abc | 21/09/2026")
    elif s=="income":
        try:
            n=int(x.replace(".","").replace(",","")); oid=ctx.user_data["oid"]; c=con()
            c.execute("INSERT INTO payments(order_id,amount,created_at) VALUES(?,?,?)",(oid,n,datetime.now().isoformat())); c.commit(); c.close(); ctx.user_data.clear()
            await u.message.reply_text(f"✅ INCOME TERCATAT\nOrder #{oid}\n💰 {rp(n)}",reply_markup=menu())
        except: await u.message.reply_text("Masukkan angka, contoh 150000")

async def modal(u,ctx):
    if ok(u):
        ctx.user_data["state"]="modal"
        await u.message.reply_text("Kirim:\nKeterangan | Nominal")
# handle modal state
async def modal_text(u,ctx):
    if not ok(u): return
    if ctx.user_data.get("state")=="modal":
        try:
            d,n=u.message.text.split("|",1); n=int(n.strip().replace(".","").replace(",",""))
            c=con(); c.execute("INSERT INTO expenses(description,amount,created_at) VALUES(?,?,?)",(d.strip(),n,datetime.now().isoformat())); c.commit(); c.close(); ctx.user_data.clear()
            await u.message.reply_text("✅ Modal tersimpan.",reply_markup=menu())
        except: await u.message.reply_text("Format: Keterangan | Nominal")
    else: await text(u,ctx)

async def ping():
    return "ok"

bot=Application.builder().token(TOKEN).build()
bot.add_handler(CommandHandler("start",start))
bot.add_handler(CommandHandler("modal",modal))
bot.add_handler(CallbackQueryHandler(cb))
bot.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND,modal_text))

@app.get("/")
def health(): return "JEJE BOT OK"

@app.post("/telegram")
async def hook():
    await bot.process_update(Update.de_json(request.get_json(),bot.bot))
    return jsonify(ok=True)

@app.post("/cron/<secret>")
def cron(secret):
    if secret!=SECRET: return "forbidden",403
    # Reminder engine can be expanded here; endpoint is ready for a free scheduler/GitHub Action.
    return jsonify(ok=True)

async def setup():
    await bot.initialize(); await bot.start()
    if BASE_URL:
        await bot.bot.set_webhook(f"{BASE_URL}/telegram")

if __name__=="__main__":
    import asyncio
    asyncio.run(setup())
    app.run(host="0.0.0.0",port=int(os.getenv("PORT","10000")))

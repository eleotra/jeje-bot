# JEJE BOT V1
Personal Telegram order manager.

BotFather only creates the bot and gives BOT_TOKEN.
Python runs the bot logic.
SQLite stores data locally.

IMPORTANT: Render Free has ephemeral local storage, so SQLite data can be lost after restart/spindown. Use SQLite for testing first; for permanent free online storage, move the database to a free cloud Postgres/Supabase later.

Environment variables:
BOT_TOKEN = BotFather token
OWNER_ID = your numeric Telegram ID
WEBHOOK_SECRET = any random secret
RENDER_EXTERNAL_URL = your Render URL

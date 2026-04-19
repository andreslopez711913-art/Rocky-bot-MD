export default {
  command: 'ping',
  aliases: ['pong'],
  owner: false,
  async execute(m, { conn }) {
    const start = Date.now()
    const chatId = m.chat || m.key.remoteJid
    await conn.sendMessage(chatId, { text: '🏓 Calculando ping...' })
    const elapsed = Date.now() - start
    await conn.sendMessage(chatId, { text: `🏓 Pong! ${elapsed}ms` })
  }
}
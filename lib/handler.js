import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import chalk from 'chalk'
import { printMensaje, printComando, printError } from './print.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

if (!global.owners) {
  global.owners = ['521234567890']
}

function normalize(jid) {
  return jid?.split('@')[0]?.replace(/[^0-9]/g, '') || ''
}

function isOwner(sender) {
  const num = normalize(sender)
  return global.owners.some(owner => normalize(owner) === num)
}

const erroresRuntimeFile = path.join(process.cwd(), 'data', 'errores-runtime.json')

function registrarError(archivo, comando, sender, err) {
  try {
    let errores = []
    if (fs.existsSync(erroresRuntimeFile)) {
      errores = JSON.parse(fs.readFileSync(erroresRuntimeFile, 'utf-8'))
    }
    errores.unshift({
      archivo,
      comando,
      sender,
      error: err.message,
      stack: err.stack?.slice(0, 400) || '',
      fecha: new Date().toLocaleString()
    })
    fs.mkdirSync(path.dirname(erroresRuntimeFile), { recursive: true })
    fs.writeFileSync(erroresRuntimeFile, JSON.stringify(errores.slice(0, 30), null, 2))
  } catch {}
}

function getTipoMensaje(msg) {
  if (!msg?.message) return null
  const tipos = [
    'conversation', 'imageMessage', 'videoMessage', 'audioMessage',
    'stickerMessage', 'documentMessage', 'extendedTextMessage',
    'reactionMessage', 'locationMessage', 'contactMessage',
    'pollCreationMessage', 'buttonsResponseMessage', 'listResponseMessage'
  ]
  for (const tipo of tipos) {
    if (msg.message?.[tipo]) return tipo
  }
  return null
}

const pluginsCache = new Map()

function cargarPlugins(dir) {
  let archivos = []
  if (!fs.existsSync(dir)) return archivos
  try {
    for (const item of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, item)
      const stat = fs.statSync(fullPath)
      if (stat.isDirectory()) {
        archivos = archivos.concat(cargarPlugins(fullPath))
      } else if (item.endsWith('.js') && !item.startsWith('_')) {
        archivos.push(fullPath)
      }
    }
  } catch (e) {
    console.error(chalk.red('Error cargando plugins:'), e.message)
  }
  return archivos
}

export async function handler(conn, chat) {
  try {
    if (!conn || !chat) return

    if (!conn.processedMessages) conn.processedMessages = new Set()
    const messageId = chat.messages?.[0]?.key?.id
    if (!messageId) return
    if (conn.processedMessages.has(messageId)) return
    conn.processedMessages.add(messageId)
    setTimeout(() => conn.processedMessages?.delete(messageId), 5000)

    const m = chat.messages[0]
    if (!m?.message) return
    if (m.key?.remoteJid === 'status@broadcast') return
    if (m.message?.protocolMessage) return
    if (m.message?.senderKeyDistributionMessage) return

    const tipo = getTipoMensaje(m)
    if (!tipo) return

    const from = m.key.remoteJid
    const sender = m.key.participant || from
    const isGroup = from.endsWith('@g.us')
    const fromMe = m.key?.fromMe || false
    const usedPrefix = global.prefix || '.'

    let text = ''
    try {
      text =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        m.message?.documentMessage?.caption ||
        ''
    } catch { text = '' }

    if (!fromMe) printMensaje(m, conn)
    if (!text || !text.startsWith(usedPrefix)) return

    const args = text.slice(usedPrefix.length).trim().split(/\s+/)
    const command = args.shift()?.toLowerCase()
    if (!command) return

    const owner = isOwner(sender)

    m.chat = from
    m.sender = sender
    m.senderNum = normalize(sender)
    m.timestamp = Date.now()
    m.isGroup = isGroup
    m.isOwner = owner
    m.text = text

    const pluginsDir = path.join(process.cwd(), 'plugins')
    const archivos = cargarPlugins(pluginsDir)

    for (const filePath of archivos) {
      try {
        let plugin
        const useCache = !global.debug && !process.env.DEBUG
        const cacheKey = `${filePath}?${command}`

        if (useCache && pluginsCache.has(cacheKey)) {
          plugin = pluginsCache.get(cacheKey)
        } else {
          const fileUrl = global.debug
            ? pathToFileURL(filePath).href + `?update=${Date.now()}`
            : pathToFileURL(filePath).href
          const module = await import(fileUrl)
          plugin = module.default || module
          if (useCache && plugin?.command) {
            pluginsCache.set(cacheKey, plugin)
          }
        }

        if (!plugin?.command) continue

        const cmds = [
          ...(Array.isArray(plugin.command) ? plugin.command : [plugin.command]),
          ...(Array.isArray(plugin.aliases) ? plugin.aliases : [])
        ].map(c => c.toLowerCase())

        if (!cmds.includes(command)) continue

        const relativo = path.relative(pluginsDir, filePath)
        printComando(usedPrefix, command, args, relativo)

        if (plugin.owner && !owner) {
          await conn.sendMessage(from, { text: '👑 Solo owners pueden usar este comando.' }, { quoted: m })
          return
        }

        try {
          await plugin(m, {
            conn,
            args,
            usedPrefix,
            isOwner: owner,
            command,
            isGroup,
            fromMe,
            text: args.join(' ')
          })
        } catch (err) {
          printError(relativo, err)
          registrarError(relativo, command, sender, err)
          const errorMsg = global.msj?.error || '❌ Error al ejecutar el comando.'
          try {
            await conn.sendMessage(from, { text: errorMsg }, { quoted: m })
          } catch {}
        }
        return
      } catch (err) {
        console.error(chalk.red(`❌ Error cargando plugin:`), err.message)
      }
    }
  } catch (error) {
    console.error(chalk.red('\n❌ ERROR CRÍTICO EN HANDLER:'), error.message)
  }
}
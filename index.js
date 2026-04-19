import './setting.js'
import pkg from '@whiskeysockets/baileys'
import Pino from 'pino'
import readline from 'readline'
import { handler } from './lib/handler.js'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { pluginLid } from 'lidsync'
import chalk from 'chalk'

const { 
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    DisconnectReason
} = pkg

const store = makeInMemoryStore({ logger: Pino({ level: 'silent' }) })

setInterval(() => {
    try {
        store.writeToFile('./baileys_store.json')
    } catch (e) {}
}, 10_000)

let filtroActivo = false

const _stdoutWrite = process.stdout.write.bind(process.stdout)
const _stderrWrite = process.stderr.write.bind(process.stderr)

const iniciosFiltro = [
    'Closing session:',
    'Closing open session',
    'Decrypted message with closed session',
    'Got receipt',
    'Got sender key',
    'Got message with closed session',
    'Unhandled receipt',
    'Appending 0 messages',
    'recv ',
    'Queueing 1',
    'Got unknown'
]

function iniciarFiltro() {
    filtroActivo = true
    process.stdout.write = (chunk, encoding, callback) => {
        const str = chunk.toString()
        if (iniciosFiltro.some(inicio => str.includes(inicio))) return true
        return _stdoutWrite(chunk, encoding, callback)
    }
    process.stderr.write = (chunk, encoding, callback) => {
        const str = chunk.toString()
        if (iniciosFiltro.some(inicio => str.includes(inicio))) return true
        return _stderrWrite(chunk, encoding, callback)
    }
}

function detenerFiltro() {
    if (!filtroActivo) return
    filtroActivo = false
    process.stdout.write = _stdoutWrite
    process.stderr.write = _stderrWrite
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (texto) => new Promise((resolver) => rl.question(texto, resolver))

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const { version } = await fetchLatestBaileysVersion()

    let useQR = true
    let numeroLimpio = ''

    if (!state.creds.registered) {
        console.clear()
        const metodo = await question("Selecciona el método de vinculación:\n1. Código QR\n2. Código de 8 dígitos (Pairing Code)\nElige (1 o 2): ")

        if (metodo.trim() === '2') {
            useQR = false
            const numero = await question("Ingresa el número de WhatsApp (con código de país, ej. 521...): ")
            numeroLimpio = numero.replace(/[^0-9]/g, "")
        }
    }

    let sock = makeWASocket({
        version,
        logger: Pino({ level: 'silent' }),
        printQRInTerminal: useQR,
        auth: state,
        browser: useQR ? ["Eris-MD", "Chrome", "1.0.0"] : ["Ubuntu", "Chrome", "22.04.4"],
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            if (store) {
                const msg = await store.loadMessage(key.remoteJid, key.id)
                return msg?.message || undefined
            }
            return {
                conversation: 'Mensaje no disponible'
            }
        }
    })

    if (!useQR && !state.creds.registered) {
        setTimeout(async () => {
            try {
                const codigo = await sock.requestPairingCode(numeroLimpio)
                const codigoFormateado = codigo?.match(/.{1,4}/g)?.join("-") || codigo
                console.log(`\n🔑 CÓDIGO DE VINCULACIÓN: ${codigoFormateado}\n`)
            } catch (error) {
                console.error("❌ Error al solicitar el código:", error.message)
            }
        }, 3000)
    }

    store.bind(sock.ev)

    sock = pluginLid(sock, { store, autoPurge: true })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr && useQR) {
            console.log(chalk.cyan('Escanea el código QR para iniciar sesión...'))
        }

        if (connection === 'connecting') {
            if (!filtroActivo) iniciarFiltro()
        }

        if (connection === 'open') {
            detenerFiltro()
            console.log(chalk.green('✅ Conexión establecida'))

            try {
                const lidStats = sock.lid && typeof sock.lid.getStats === 'function' ? sock.lid.getStats() : null
                if (lidStats) {
                    console.log(chalk.blue(`[LidSync] Cache inicializada: ${lidStats.size}/${lidStats.maxSize}`))
                }
            } catch {}

            try {
                const botId = sock.user?.id?.replace(/:.*@/, '@') || ''
                if (botId) {
                    await sock.sendMessage(botId, {
                        text: `🤖 *${global.namebot}* en línea\n📅 ${new Date().toLocaleString()}`
                    })
                }
            } catch {}
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode
            if (reason !== DisconnectReason.loggedOut) {
                console.log(chalk.yellow('🔄 Reconectando...'))
                if (sock.lid && typeof sock.lid.destroy === 'function') {
                    sock.lid.destroy()
                }
                start()
            } else {
                console.log(chalk.red('❌ Sesión cerrada'))
                process.exit(0)
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async (m) => {
        await handler(sock, m)
    })

    return sock
}

start()
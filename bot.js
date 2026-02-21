const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")
const axios = require("axios")
const P = require("pino")

const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || "http://localhost:5678/webhook"
const DAILY_SEND_ENABLED = (process.env.DAILY_SEND_ENABLED || "false").toLowerCase() === "true"
const DAILY_SEND_TIME = process.env.DAILY_SEND_TIME || "10:00"
const DAILY_SEND_TO = process.env.DAILY_SEND_TO || ""

let dailySchedulerHandle = null

function normalizeRecipient(input) {
    const raw = String(input || "").trim()
    if (!raw) return ""
    if (raw.includes("@")) return raw

    let digits = raw.replace(/\D/g, "")
    if (digits.startsWith("0")) digits = `62${digits.slice(1)}`

    return digits ? `${digits}@s.whatsapp.net` : ""
}

function getDailyRecipients() {
    return DAILY_SEND_TO
        .split(",")
        .map((value) => normalizeRecipient(value))
        .filter(Boolean)
}

function parseTimeToMinutes(timeText) {
    const [hourText = "10", minuteText = "00"] = String(timeText).split(":")
    const hour = Number(hourText)
    const minute = Number(minuteText)

    if (Number.isNaN(hour) || Number.isNaN(minute)) return 600
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return 600

    return hour * 60 + minute
}

async function sendDailySummary(sock) {
    const [totalResult, totalHutangResult] = await Promise.allSettled([
        axios.post(`${WEBHOOK_BASE_URL}/total`),
        axios.post(`${WEBHOOK_BASE_URL}/totalhutang`)
    ])

    let totalText = "Data total bulan ini tidak tersedia."
    if (totalResult.status === "fulfilled" && totalResult.value?.data?.total !== undefined) {
        const total = Number(totalResult.value.data.total || 0)
        totalText = `Total bulan ini: Rp ${new Intl.NumberFormat("id-ID").format(total)}`
    }

    let hutangText = "Data total hutang tidak tersedia."
    if (totalHutangResult.status === "fulfilled" && totalHutangResult.value?.data?.total !== undefined) {
        const totalHutang = Number(totalHutangResult.value.data.total || 0)
        hutangText = `Total hutang aktif: Rp ${new Intl.NumberFormat("id-ID").format(totalHutang)}`
    }

    const now = new Date()
    const tanggal = now.toLocaleDateString("id-ID")
    const message = `Laporan harian (${tanggal})\n${totalText}\n${hutangText}`
    const recipients = getDailyRecipients()
    await Promise.allSettled(recipients.map((jid) => sock.sendMessage(jid, { text: message })))
}

function setupDailyScheduler(sock) {
    if (!DAILY_SEND_ENABLED) {
        console.log("Daily scheduler nonaktif. Set DAILY_SEND_ENABLED=true untuk mengaktifkan.")
        return
    }

    const recipients = getDailyRecipients()
    if (recipients.length === 0) {
        console.log("DAILY_SEND_TO belum diisi. Scheduler harian tidak dijalankan.")
        return
    }

    if (dailySchedulerHandle) {
        clearInterval(dailySchedulerHandle)
    }

    const targetMinutes = parseTimeToMinutes(DAILY_SEND_TIME)
    let lastSentDate = ""

    dailySchedulerHandle = setInterval(async () => {
        const now = new Date()
        const currentMinutes = now.getHours() * 60 + now.getMinutes()
        const dateKey = now.toISOString().slice(0, 10)

        if (currentMinutes < targetMinutes || dateKey === lastSentDate) return

        try {
            await sendDailySummary(sock)
            lastSentDate = dateKey
            console.log(`Laporan harian terkirim ke ${recipients.join(", ")} pada ${now.toLocaleString("id-ID")}`)
        } catch (err) {
            console.log("Gagal kirim laporan harian:", err.message)
        }
    }, 30000)

    console.log(`Daily scheduler aktif. Target kirim ${DAILY_SEND_TIME} (waktu server).`)
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./session")

    const sock = makeWASocket({
        auth: state,
        logger: P({ level: "silent" })
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log("Scan QR ini:")
            qrcode.generate(qr, { small: true })
        }

        if (connection === "open") {
            console.log("WhatsApp Connected!")
            setupDailyScheduler(sock)
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

            console.log("Connection closed. Reconnecting...", shouldReconnect)

            if (shouldReconnect) {
                startBot()
            }
        }
    })

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0]
        if (!msg.message) return

        let text = ""

        if (msg.message.conversation) {
            text = msg.message.conversation
        } else if (msg.message.extendedTextMessage) {
            text = msg.message.extendedTextMessage.text
        }

        if (!text) return

        const from = msg.key.remoteJid
        const cleanText = text.trim()
        const command = cleanText.split(" ")[0]

        if (command === "/keluar") {
            try {
                const parts = cleanText.split(" ")
                if (parts.length < 2) {
                    return sock.sendMessage(from, { text: "Format salah. Contoh: /keluar 10000 kopi" })
                }

                await axios.post(`${WEBHOOK_BASE_URL}/keluar`, { text: cleanText })

                const nominal = Number(parts[1])
                const format = new Intl.NumberFormat("id-ID").format(nominal)

                await sock.sendMessage(from, {
                    text: `Pengeluaran Rp ${format} berhasil disimpan!`
                })
            } catch (err) {
                await sock.sendMessage(from, { text: "Gagal menyimpan data." })
            }
        } else if (command === "/total") {
            try {
                const res = await axios.post(`${WEBHOOK_BASE_URL}/total`)

                if (!res.data?.total) {
                    return sock.sendMessage(from, { text: "Total tidak ditemukan." })
                }

                const formatRupiah = new Intl.NumberFormat("id-ID").format(res.data.total)

                await sock.sendMessage(from, {
                    text: `Total bulan ini: Rp ${formatRupiah}`
                })
            } catch (err) {
                await sock.sendMessage(from, { text: "Gagal mengambil total." })
            }
        } else if (command === "/hariini") {
            try {
                const res = await axios.post(`${WEBHOOK_BASE_URL}/hariini`)

                await sock.sendMessage(from, {
                    text: res.data.message || "Tidak ada data hari ini."
                })
            } catch (err) {
                await sock.sendMessage(from, { text: "Gagal mengambil data hari ini." })
            }
        } else if (command === "/info") {
            await sock.sendMessage(from, {
                text:
                    "Daftar perintah:\n" +
                    "/keluar <nominal> <keterangan>\n" +
                    "/total\n" +
                    "/hariini\n" +
                    "/hutang <nama> <nominal>\n" +
                    "/totalhutang\n" +
                    "/listhutang\n" +
                    "/deletehutang <nama>\n" +
                    "/deleteallhutang"
            })
        } else if (command === "/hutang") {
            try {
                const parts = cleanText.split(" ")
                if (parts.length < 3) {
                    return sock.sendMessage(from, { text: "Format salah. Contoh: /hutang Budi 50000" })
                }

                await axios.post(`${WEBHOOK_BASE_URL}/hutang`, { text: cleanText })

                const nominal = Number(parts[2])
                const format = new Intl.NumberFormat("id-ID").format(nominal)

                await sock.sendMessage(from, {
                    text: `Hutang Rp ${format} ke ${parts[1]} berhasil dicatat.`
                })
            } catch (err) {
                await sock.sendMessage(from, { text: "Gagal mencatat hutang." })
            }
        } else if (command === "/totalhutang") {
            try {
                const res = await axios.post(`${WEBHOOK_BASE_URL}/totalhutang`)

                if (!res.data?.total) {
                    return sock.sendMessage(from, { text: "Total hutang tidak ditemukan." })
                }

                const format = new Intl.NumberFormat("id-ID").format(res.data.total)

                await sock.sendMessage(from, {
                    text: `Total hutang aktif: Rp ${format}`
                })
            } catch (err) {
                await sock.sendMessage(from, { text: "Gagal mengambil total hutang." })
            }
        } else if (command === "/listhutang") {
            try {
                const res = await axios.post(`${WEBHOOK_BASE_URL}/listhutang`)

                if (typeof res.data?.message === "string" && res.data.message.trim()) {
                    return sock.sendMessage(from, { text: res.data.message })
                }

                const list = res.data?.items || res.data?.data || res.data?.hutang || []
                if (!Array.isArray(list) || list.length === 0) {
                    return sock.sendMessage(from, { text: "Tidak ada hutang saat ini" })
                }

                const lines = list.map((item, i) => {
                    const nama = item.nama || item.name || "Tanpa nama"
                    const nominal = Number(item.nominal ?? item.amount ?? 0)
                    const tanggal = item.tanggal || item.date
                    const keterangan = item.keterangan || item.note
                    const formatNominal = new Intl.NumberFormat("id-ID").format(nominal)

                    let line = `${i + 1}. ${nama} - Rp ${formatNominal}`
                    if (tanggal) line += ` (${tanggal})`
                    if (keterangan) line += `\n   ${keterangan}`
                    return line
                })

                await sock.sendMessage(from, {
                    text: `List Hutang Aktif:\n${lines.join("\n")}`
                })
            } catch (err) {
                await sock.sendMessage(from, { text: "Gagal mengambil list hutang." })
            }
        } else if (command === "/deletehutang") {
            try {
                const parts = cleanText.split(" ")
                if (parts.length < 2) {
                    return sock.sendMessage(from, {
                        text: "Format salah. Contoh: /deletehutang Budi"
                    })
                }

                const target = parts.slice(1).join(" ")
                const res = await axios.post(`${WEBHOOK_BASE_URL}/deletehutang`, {
                    text: cleanText,
                    target
                })

                await sock.sendMessage(from, {
                    text: res.data?.message || `Hutang '${target}' berhasil dihapus.`
                })
            } catch (err) {
                await sock.sendMessage(from, { text: "Gagal menghapus hutang." })
            }
        } else if (
            command === "/deleteallhutang" ||
            command === "/deletehutangall" ||
            command === "/deletehutangsemua"
        ) {
            try {
                const res = await axios.post(`${WEBHOOK_BASE_URL}/deleteallhutang`, {
                    text: cleanText
                })

                await sock.sendMessage(from, {
                    text: res.data?.message || "Semua data hutang berhasil dihapus."
                })
            } catch (err) {
                await sock.sendMessage(from, { text: "Gagal menghapus semua hutang." })
            }
        }
    })
}

startBot()

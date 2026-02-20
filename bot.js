const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")
const axios = require("axios")
const P = require("pino")

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
            console.log("✅ WhatsApp Connected!")
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

            console.log("❌ Connection closed. Reconnecting...", shouldReconnect)

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

        // ====== KELUAR ======
        if (text.startsWith("/keluar")) {
            try {
                await axios.post("http://localhost:5678/webhook/keluar", {
                    text: text
                })

                const parts = text.split(" ")
                const nominal = Number(parts[1])
                const format = new Intl.NumberFormat("id-ID").format(nominal)

                await sock.sendMessage(from, {
                    text: `✅ Pengeluaran Rp ${format} berhasil disimpan!`
                })

            } catch (err) {
                await sock.sendMessage(from, {
                    text: "❌ Gagal menyimpan data."
                })
            }
        }


        // ====== TOTAL ======
        if (text.startsWith("/total")) {
            try {
                const res = await axios.post("http://localhost:5678/webhook/total")

                const total = res.data.total

                const formatRupiah = new Intl.NumberFormat("id-ID").format(total)

                await sock.sendMessage(from, {
                    text: `📊 Total bulan ini: Rp ${formatRupiah}`
                })

            } catch (err) {
                console.log("ERROR AXIOS:", err.response?.data || err.message)

                await sock.sendMessage(from, {
                    text: "❌ Gagal mengambil total."
                })
            }
        }


        if (text.startsWith("/hariini")) {
            try {
                const res = await axios.post("http://localhost:5678/webhook/hariini")

                await sock.sendMessage(from, {
                    text: res.data.message
                })

            } catch (err) {
                console.log("ERROR HARIINI:", err.response?.data || err.message)

                await sock.sendMessage(from, {
                    text: "❌ Gagal mengambil data hari ini."
                })
            }
        }


    })

}

startBot()

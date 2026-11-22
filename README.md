# 🤖 Facebook Automate Post Groups

Dashboard web + bot posting ke grup Facebook via Puppeteer + SQLite (`fb_auto_poster.db`).

🚀 Untuk **marketer**, **community manager**, atau siapa pun yang mengelola banyak grup.
⚠️ **Gunakan dengan bijak** — automasi bisa melanggar ketentuan Facebook.

---

## ✨ Features

* 📝 Post **teks** + 📷 **gambar** ke banyak grup sekaligus (Post Sekarang / Terjadwal / Template).
* ⏸️ **Pause / Resume / Stop** saat posting berjalan; progress + log **tahan refresh**.
* ⏱️ **Auto-pause 1 jam** saat terdeteksi SPAM atau `Network request timed out (ComposerStoryCreateMutation)` — lanjut otomatis dari grup yang sama, berulang tanpa batas.
* 🚫 **Blacklist otomatis**: grup dengan error `Post box tidak ditemukan` langsung dihapus dari Manajemen Grup + dicatat agar tidak masuk lagi saat scan.
* 🔐 Deteksi **sesi expired** (`session_invalid`) — tercatat di Riwayat, posting dihentikan.
* 🔍 **Scan grup** yang sudah di-join + simpan ke database.
* 👥 Multi-akun (login manual / import cookies), 🕒 scheduler (`node-cron`), 📊 riwayat + dashboard statistik.

---

## 📦 Prerequisites

* 🛠️ Node.js 18+ (`npm install` akan mengunduh `puppeteer`, `express`, `better-sqlite3`, dll).
* 🌐 Koneksi internet + akun Facebook dengan cookies valid (diinput lewat dashboard, tersimpan di SQLite — bukan file `fb_cookies.json`).

---

## 🛠️ Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/novalbahri17/MBA-fb-assistant.git
   cd MBA-fb-assistant
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Jalankan server:

   ```bash
   node server-v2.js
   # atau di Windows: START-SERVER.bat
   ```

4. Buka dashboard: `http://localhost:8080` (atau sesuai `PORT`).

---

## 🚀 Usage

1. **Tambah akun**: buka halaman **Akun** → tambah via **Login Facebook** (browser otomatis) atau **Import Cookies** (paste JSON dari extension `EditThisCookie`).
2. **Kumpulkan grup**: halaman **Grup** → **Scan Grup** → pilih hasil scan → **Simpan**.
3. **Posting**: halaman **Post** → pilih akun + grup target + tulis konten / pilih gambar dari galeri → **Post Sekarang** (atau buat **Jadwal** / **Template**).
4. Saat posting berjalan: tombol **Pause / Resume / Stop** tersedia; halaman boleh di-refresh — progress + log dipulihkan otomatis.
5. Jika muncul SPAM / `Network request timed out`: sistem **auto-pause 1 jam** lalu lanjut sendiri dari grup yang sama (berulang tanpa batas). Grup tanpa post box otomatis masuk **Blacklist** dan hilang dari daftar.

---

## 🗂️ File Structure

```
MBA-fb-assistant/
├── server-v2.js             # 🚀 Entry point (Express + WebSocket + scheduler)
├── fbPosterCore.js           # 🤖 Inti automasi Puppeteer (posting, deteksi spam/sesi/blacklist)
├── fbLogin.js / fbScraper.js / groupScanner.js  # 🔑 Login, scrape, scan grup
├── database/
│   ├── connection.js        # 🗄️ SQLite (better-sqlite3) + migrasi tabel
│   └── models/              # Account, Group, GroupBlacklist, PostHistory, ScheduledPost, Template
├── public-v2/               # 🖥️ Dashboard (post, groups, history, scheduled, templates, ...)
├── web-dashboard/uploads/   # 📤 Gambar yang diupload lewat dashboard
├── img/                     # 🖼️ Gambar lokal (tidak di-commit)
├── fb_auto_poster.db        # 🗄️ Database SQLite (tidak di-commit)
├── package.json
└── README.md
```

> File sensitif (`fb_cookies.json`, `*.db`, `img/`, `.env`) **tidak di-commit** via `.gitignore`.
> Folder `web-dashboard/uploads/` **di-commit** (berisi gambar contoh posting).

---

---

## 🆕 Fitur Baru: Scan Grup Otomatis

Fitur ini memungkinkan Anda untuk secara otomatis memindai dan mengambil daftar grup Facebook yang telah Anda join, tanpa perlu input manual.

### Cara Menggunakan

1. Buka dashboard web di `http://localhost:8080/groups.html`
2. Klik tombol **"Scan Grup"** di halaman Groups
3. Pilih akun Facebook yang ingin digunakan
4. Atur opsi scan (jumlah scroll maksimum, adaptive delay)
5. Klik **"Mulai Scan"**
6. Tunggu proses scan selesai
7. Pilih grup yang ingin disimpan
8. Klik **"Simpan yang Dipilih"** (grup yang sudah di-blacklist otomatis dilewati)

### API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| POST | `/api/groups/scan` | Mulai scan grup |
| GET | `/api/groups/scan/:scanId` | Cek status scan |
| POST | `/api/groups/scan/:scanId/cancel` | Batalkan scan |
| POST | `/api/groups/save` | Simpan grup ke database |
| GET | `/api/groups/blacklist` | Lihat grup blacklist |
| DELETE | `/api/groups/blacklist/:groupId` | Keluarkan grup dari blacklist |
| DELETE | `/api/groups/blacklist` | Kosongkan blacklist |
| POST | `/api/post-now` | Posting sekarang (dengan pause/resume/stop + auto-pause) |
| POST | `/api/post-now/pause` | Pause posting |
| POST | `/api/post-now/resume` | Lanjutkan posting |
| POST | `/api/post-now/stop` | Hentikan posting |
| GET | `/api/post-now/current` | Snapshot progress + log (untuk pulihkan setelah refresh) |

### Modul groupScanner.js

Modul baru `groupScanner.js` menyediakan fungsi-fungsi untuk scanning:

```javascript
const { scanJoinedGroups, NetworkHealthMonitor } = require('./groupScanner');

// Scan grup yang sudah di-join
const result = await scanJoinedGroups(page, {
  maxScrolls: 50,
  onProgress: (scanned, total) => console.log(`Progress: ${scanned}/${total}`)
});
```

### Testing

Jalankan test suite untuk memverifikasi fitur scan:
```bash
node test-group-scanner.js
```

---

## 🆕 Fitur Baru: Auto-Pause 1 Jam (Spam / Network Timeout)

Saat posting berjalan dan terdeteksi **SPAM / akun dibatasi** atau error
`Network request timed out. ComposerStoryCreateMutation(...)`:

1. Posting **auto-pause 1 jam** (countdown per menit di log + badge di dashboard).
2. Setelah 1 jam, progres **lanjut otomatis dari grup yang sama**.
3. Jika terdeteksi lagi → auto-pause 1 jam lagi, **berulang tanpa batas** (tidak ada max retry).
4. Tombol **Stop** tetap bisa menghentikan kapan saja; grup yang akan di-retry **tidak** ditulis ke Riwayat (bukan kegagalan final).

## 🆕 Fitur Baru: Blacklist Grup Tanpa Post Box

Grup dengan error `Post box tidak ditemukan di halaman utama` (composer dimatikan / grup dikunci admin):

1. Otomatis masuk tabel `group_blacklist` + **dihapus dari Manajemen Grup**.
2. Tidak akan masuk lagi saat scan berikutnya.
3. Bisa dikeluarkan lagi lewat panel **Grup Blacklist** di halaman Grup, atau API `DELETE /api/groups/blacklist/:groupId`.

---

## 🆕 Fitur Baru: Dual Account Addition

Sekarang Anda bisa menambahkan akun Facebook dengan **2 cara**:

### Cara 1: Login Facebook (Manual)
1. Buka dashboard → halaman **Akun**
2. Klik tombol **"Tambah Akun"**
3. Pilih tab **"Login Facebook"**
4. Isi nama akun (opsional)
5. Klik **"Buka Browser & Login"**
6. Login di browser yang terbuka
7. Sistem otomatis mengambil cookies dan scan grup

### Cara 2: Import Cookies
1. Buka dashboard → halaman **Akun**
2. Klik tombol **"Tambah Akun"**
3. Pilih tab **"Import Cookies"**
4. Isi nama akun (opsional)
5. Paste cookies JSON yang sudah di-export dari browser
6. Klik **"Import & Scan"**
7. Sistem akan validasi cookies, ambil profil, dan scan grup otomatis

### Cara Export Cookies dari Browser
1. Install extension **EditThisCookie** atau **Get cookies.txt LOCALLY**
2. Login ke Facebook di browser
3. Klik extension → Export → Copy
4. Paste di form Import Cookies

### API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| POST | `/api/accounts/import-cookies` | Tambah akun via import cookies |
| POST | `/api/login-facebook` | Tambah akun via login manual |
| POST | `/api/accounts/validate-cookies` | Validasi cookies |

---

## ⚠️ Notes

* 🔄 Ensure your session cookies are **valid and up to date**.
* 📛 Post responsibly to stay within **Facebook's platform policies**.

### 🕒 **Post Frequency Guidelines:**

* **1-3 posts per day** to prevent being flagged as spam.
* **2-4 hour interval** between posts.
* Avoid **back-to-back** or rapid posting.
* **Engage** with the group through comments and likes.
* For **new accounts**, limit posting in the first 30 days.

---

## 📢 Disclaimer

This tool is intended for **educational purposes only**.
🛡️ The author assumes no responsibility for misuse or any consequences resulting from its use.

---

## 📄 License

This project is licensed under the **MIT License**.
See the `LICENSE` file for more information.

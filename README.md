# 🤖 Facebook Automate Post Groups

Automate posting to Facebook groups with ease! This lightweight Node.js tool lets you schedule text, image, or link posts across multiple Facebook groups using session cookies—**no browser automation required**.

🚀 Perfect for **marketers**, **community managers**, or anyone managing multiple groups.
⚠️ **Use responsibly** — automation may violate Facebook’s terms of service.

---

## ✨ Features

* 📝 Post **text**, 📷 **images**, or 🔗 **links** to multiple Facebook groups.
* ⏰ **Schedule** posts for specific times.
* 🔐 Uses **session cookies** (no browser automation).
* ⚡ **Lightweight** and easy to configure.

---

## 📦 Prerequisites

* 🛠️ Node.js installed on your system.
* 🔑 Facebook session cookies (`fb_cookies.json`).

---

## 🛠️ Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/your-username/facebook-automate-post-groups.git
   cd facebook-automate-post-groups
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

---

## 🚀 Usage

1. **Prepare your session cookies**:
   Export your Facebook session cookies and save them as `fb_cookies.json` in the project root (Using `EditThisCookie (V3) 3.0.4`)

2. **Add images** (if needed):
   Place images in the `img/` folder to include them in posts.

3. **Run the script**:

   ```bash
   node main.js
   ```

4. **Customize** the `post_to_group.js` file:
   Define the Facebook group IDs, post content, and schedule to suit your needs.

---

## 🗂️ File Structure

```
facebook-automate-post-groups/
├── fb_cookies.json       # 🔑 Facebook session cookies file
├── package.json          # 📦 Project dependencies
├── post_to_group.js      # 🚀 Main script for posting
├── README.md             # 📘 Documentation
├── test.js               # 🧪 Test script
├── img/                  # 🖼️ Image folder
│   ├── 1-living-room-1.jpg
│   ├── 2-bedroom-1.2.jpg
│   ├── ...
```

---

## 🆕 Fitur Baru: Scan Grup Otomatis

Fitur ini memungkinkan Anda untuk secara otomatis memindai dan mengambil daftar grup Facebook yang telah Anda join, tanpa perlu input manual.

### Cara Menggunakan

1. Buka dashboard web di `http://localhost:3000/groups`
2. Klik tombol **"Scan Grup"** di halaman Groups
3. Pilih akun Facebook yang ingin digunakan
4. Atur opsi scan (jumlah scroll maksimum, adaptive delay)
5. Klik **"Mulai Scan"**
6. Tunggu proses scan selesai
7. Pilih grup yang ingin disimpan
8. Klik **"Simpan yang Dipilih"**

### API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| POST | `/api/groups/scan` | Mulai scan grup |
| GET | `/api/groups/scan/:scanId` | Cek status scan |
| POST | `/api/groups/scan/:scanId/cancel` | Batalkan scan |
| POST | `/api/groups/save` | Simpan grup ke database |

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

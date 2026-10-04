# Kasir Smart — aplikasi kasir (POS) untuk UMKM

Aplikasi web yang bisa dibuka dari HP, tablet, maupun komputer lewat browser, dan bisa
"dipasang" seperti aplikasi (PWA). **Tanpa dependensi** — hanya butuh Python 3.8+ (atau Docker).
Data tersimpan di satu berkas SQLite.

## Fitur
| Area | Yang tersedia |
|---|---|
| Transaksi | Grid produk + pencarian, scan barcode lewat **kamera HP** atau **scanner USB/Bluetooth**, diskon (Rp / %), pajak/PPN, nama & WA pelanggan |
| Pembayaran | Tunai (uang pas, saran pecahan, kembalian), **QRIS** (menampilkan gambar QRIS toko), debit, kredit, e-wallet |
| Struk | Cetak ke printer thermal 58/80 mm (lewat dialog cetak browser / aplikasi printer Bluetooth), kirim ke **WhatsApp**, kirim via email |
| Stok | Berkurang otomatis saat jual, kembali saat transaksi dibatalkan, peringatan stok menipis (lencana di menu + ringkasan di laporan), barang masuk / stok opname / barang rusak, riwayat pergerakan stok |
| Varian | Ukuran, warna, rasa, topping — stok, harga, modal, dan barcode per varian |
| Laporan | Omzet harian/bulanan/tahunan, laba kotor & bersih, HPP, arus kas, produk terlaris, per metode bayar, per kasir; ekspor **Excel**, **CSV**, **PDF** |
| Pengeluaran | Catat biaya operasional (otomatis masuk laba bersih & arus kas) |
| Offline | Aplikasi tetap terbuka tanpa internet; transaksi disimpan di perangkat dan **otomatis disinkronkan** saat online (anti-duplikat) |
| Hak akses | **Pemilik**: semua fitur. **Kasir**: hanya transaksi + riwayat miliknya hari ini. Pembatalan transaksi, produk, laporan, pengguna = pemilik saja |
| Keamanan | Password di-hash (PBKDF2), sesi token, pembatasan percobaan login, harga dihitung ulang di server |
| Cadangan | Unduh backup database dari menu Setelan |

## Login awal (SEGERA GANTI)
- Pemilik: `admin` / `admin123`
- Kasir: `kasir` / `kasir123`

Ganti di **Setelan → Ganti password** dan **Setelan → Pengguna**. Produk contoh bisa dihapus di menu Produk.

## Cara menjalankan

### A. Docker (paling mudah)
```bash
docker compose up -d --build
# buka http://IP-SERVER:8080
```
Data tersimpan di volume `kasir-data` (aman saat container di-update).

### B. Tanpa Docker (Ubuntu/Debian)
```bash
sudo apt install -y python3
sudo mkdir -p /opt/kasir-smart && sudo cp -r . /opt/kasir-smart
sudo useradd -r -s /usr/sbin/nologin kasir
sudo mkdir -p /opt/kasir-smart/data && sudo chown -R kasir /opt/kasir-smart/data
sudo cp /opt/kasir-smart/deploy/kasir-smart.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now kasir-smart
```
Coba cepat tanpa service: `./run.sh` (port 8080).

### C. Wajib untuk pemakaian umum: HTTPS
Scan kamera, pemasangan aplikasi (PWA), dan mode offline **hanya berfungsi lewat HTTPS**.
1. Arahkan domain (mis. `kasir.tokoanda.com`) ke IP server.
2. Pasang Caddy (HTTPS otomatis): `sudo apt install caddy`, salin `deploy/Caddyfile` ke
   `/etc/caddy/Caddyfile` (ganti domainnya), lalu `sudo systemctl reload caddy`.
   Alternatif Nginx + Certbot: lihat `deploy/nginx.conf`.
3. Buka port 80 & 443 di firewall. Dengan reverse proxy, jalankan aplikasi di `127.0.0.1`
   (`KASIR_HOST=127.0.0.1`, atau `"127.0.0.1:8080:8080"` di docker-compose) agar port 8080 tidak terbuka ke publik.

## Konfigurasi (environment)
| Variabel | Default | Keterangan |
|---|---|---|
| `KASIR_HOST` | `0.0.0.0` | alamat listen |
| `KASIR_PORT` | `8080` | port |
| `KASIR_DB` | `./data/kasir.db` | lokasi database |
| `KASIR_TZ` | `7` | zona waktu (7=WIB, 8=WITA, 9=WIT) |
| `KASIR_ADMIN_PASSWORD` | `admin123` | password awal admin (hanya saat DB baru dibuat) |

## Tips pemakaian
- **Pasang di HP**: buka situs di Chrome → menu ⋮ → *Tambahkan ke layar utama* (atau tombol di Setelan).
- **Printer Bluetooth**: pasangkan printer di Bluetooth HP; tekan *Cetak struk* lalu pilih printer
  (di Android biasanya lewat aplikasi/layanan cetak bawaan printer, mis. RawBT).
- **Scanner barcode USB/Bluetooth** bekerja otomatis (dianggap keyboard): buka menu Kasir lalu scan.
- **Backup**: unduh rutin dari Setelan → *Unduh backup*.
- **Mode offline**: tanpa internet, stok diperiksa dari data terakhir di perangkat. Transaksi offline boleh
  membuat stok minus sementara, lalu menyesuaikan saat sinkron. Riwayat & laporan butuh koneksi.
- **Beberapa kasir sekaligus** didukung; stok di perangkat diperbarui otomatis tiap 30 detik.
- Harga pada transaksi offline mengikuti harga di server saat sinkron, bukan harga di perangkat.

## Struktur proyek
```
server.py            backend (API + file statis), SQLite
static/              antarmuka web (index.html, app.js, style.css, sw.js, manifest, ikon)
deploy/              contoh systemd, Caddy, Nginx
Dockerfile, docker-compose.yml, run.sh
```

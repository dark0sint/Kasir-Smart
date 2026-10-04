# Membuat ikon PNG (tanpa library). Jalankan: python3 gen_icons.py
import zlib, struct
def png(size, path):
    navy, saffron, white = (20,33,61), (242,169,0), (255,255,255)
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            u, v = x/size, y/size
            c = navy
            # tepi struk bergerigi di bawah
            # huruf K : batang + dua diagonal
            inK = (0.30<=u<=0.40 and 0.25<=v<=0.75)
            up = 0.40<=u<=0.72 and 0.25<=v<=0.50 and abs((u-0.40)-(0.50-v)*1.28)<0.055
            dn = 0.40<=u<=0.72 and 0.50<=v<=0.75 and abs((u-0.40)-(v-0.50)*1.28)<0.055
            if inK or up or dn: c = saffron
            # sudut membulat (maskable aman karena konten di tengah)
            row += bytes(c)
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d):
        b = struct.pack('>I', len(d)) + t + d
        return b + struct.pack('>I', zlib.crc32(t+d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(data)
png(192, 'static/icon-192.png'); png(512, 'static/icon-512.png')

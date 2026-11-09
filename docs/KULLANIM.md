# CPPWRF Tahmin: Kullanım kılavuzu

CPPWRF Tahmin, kendi bilgisayarınızda gerçek verilerle sayısal hava tahmini çalıştıran ve sonucu haritada
gösteren bir sitedir. Model, WRF'nin C++'a satır satır aktarılmış hâli olan CPPWRF'dir; başlangıç verisi
NOAA'nın GFS küresel modelinden gelir.

> **Uyarı.** Bu site resmî bir hava tahmini değildir. Sonuç, GFS girdisi, seçilen bölge, çözünürlük ve fizik
> ayarları kadar iyidir. Can ve mal güvenliğini ilgilendiren kararlar için Meteoroloji Genel Müdürlüğü'nün resmî
> tahmin ve uyarılarını izleyin.

## Kurulum

Gerekenler: Linux, NVIDIA GPU ve CUDA (GPU kipleri için; GPU yoksa CPU kipi çalışır), g++, CMake, Ninja,
NetCDF-C, Python 3, WPS 4.6.0 ve coğrafya verisi, WRF'nin fizik tabloları.

```bash
git clone --recursive https://github.com/Xassemblianist/CPPWRF-WEB.git
cd CPPWRF-WEB
tools/build_all.sh                               # üç model derlemesi ve sunucu
build/forecast/cppwrf-forecast --port 8090       # sunucu
tools/calibrate.sh                               # bir kez, ~10 dk: tahminleri bu makineye göre ölçer
```

Sonra tarayıcıda `http://127.0.0.1:8090/` adresini açın. Sunucu yalnız bu bilgisayardan erişilebilir.

WPS, coğrafya verisi ve WRF tabloları başka bir yerdeyse `WPS_DIR`, `GEOG_DIR` ve `WRF_RUN_DIR` ortam
değişkenleriyle gösterin.

## GitHub Pages'ten kullanmak

Site <https://xassemblianist.github.io/CPPWRF-WEB/forecast/> adresinde de açılır. Bilgisayarınızda sunucu
çalışıyorsa sayfa ona kendiliğinden bağlanır ve tahmini sizin bilgisayarınızda çalıştırır. Sunucu çalışmıyorsa
yayımlanmış örnek tahminleri gösterir. Üst çubuktaki yeşil nokta sunucuya bağlı olduğunuzu gösterir.

## Yeni tahmin

Soldaki paneldeki **Yeni tahmin** sekmesi:

1. **Bölge.** Haritaya tıklayarak merkezi seçin ya da **Shift** basılıyken sürükleyerek bir dikdörtgen çizin.
   Izgara aralığı (1–50 km), nokta sayıları ve dikey seviye sayısı (30–100) serbesttir. Harita izdüşümü enleme
   göre kendiliğinden seçilir (ekvator yakınında Mercator, kutuplarda kutupsal, arada Lambert); isterseniz
   değiştirebilirsiniz.
2. **Zaman.** GFS çevrimi (en son tam çevrim ya da son sekiz günden biri), tahmin süresi (1–384 saat), çıktı
   aralığı ve zaman adımı. Önerilen adım yaklaşık 6 × dx (km) saniyedir ve çıktı aralığını bölecek biçimde
   seçilir. 120 saate kadar GFS saatlik, sonrası 3 saatliktir.
3. **İç alan (nest).** "İç alan ekle" ile ana alanın içine 1:3 ya da 1:5 oranında daha ince bir alan
   koyabilirsiniz; Shift ile sürükleyerek yerini çizin. Tek ya da iki yönlü etkileşim seçilebilir.
4. **Fizik.** Bir ön ayar seçin (ör. "Klasik: WSM6 + Kain-Fritsch + YSU"). **Gelişmiş seçenekler** bölümünde
   CPPWRF'nin desteklediği her seçenek vardır; değerler CPPWRF'nin kendi çeviricisinden okunur. Desteklenmeyen
   bir birleşimde hata ilgili ayarın hemen altında görünür.
5. **Model kipi.**
   - **GPU · FP32 (hızlı):** en hızlısı; sonuç FP64'ten yuvarlama kadar farklıdır.
   - **GPU · FP64 (WRF ile birebir):** çıktı, CPU FP64 kipinin çıktısıyla bayt bayt aynıdır.
   - **CPU · FP64 (yedek):** GPU yoksa; en yavaşı.

### Tahmini maliyet

Panel, her değişiklikte bu ayarların bu bilgisayarda ne kadar süreceğini aşama aşama gösterir: GFS indirme,
geogrid, ungrib, metgrid, real, model ve ürünler; ayrıca GPU belleği, RAM, disk, GFS indirme boyutu, çıktı karesi
sayısı, tahmini bitiş saati (TSİ) ve aynı ayarların diğer kiplerde ne kadar süreceği.

- **Yeşil (Uygun):** çalıştırabilirsiniz.
- **Sarı (Dikkat):** 30 dakikadan uzun sürecek ya da GPU belleğinin %70'inden fazlası gerekecek. Başlatırken
  "Uzun sürecek, devam etmek istiyor musun?" diye sorulur.
- **Kırmızı (Çalıştırılamaz):** bu makineye sığmıyor. Panel sığması için en ucuz değişikliği önerir (ör. FP32
  kipi, daha az nokta ya da daha büyük dx).

Tahminler her bitmiş çalışmadan sonra kendini düzeltir. Kitaplıkta her çalışmanın tahmin edilen ve gerçekleşen
süresi yan yana görünür.

## Tahmin çalışırken

Sağ üstte ilerleme kartı açılır: aşamalar, yüzde, geçen süre, simüle edilen süre, saniyedeki adım sayısı, gerçek
zamanın kaç katı hızla gidildiği ve kalan süre. "Günlükler" o aşamanın son satırlarını gösterir. **İptal** düğmesi
çalışmayı durdurur ve ara dosyaları siler (isterseniz "ara dosyaları sakla" kutusunu işaretleyin).

Model çalışırken hazır olan kareler haritada açılabilir ("Hazır kareleri göster"). Sayfa arka plandayken tahmin
biterse tarayıcı bildirimi gelir.

Aynı anda bir tahmin çalışır; diğerleri kuyrukta bekler.

## Harita

- **Katmanlar** (sağdaki şerit, kısayol **1–9**): rüzgâr, hamle, sıcaklık, çiy noktası, bağıl nem, deniz
  seviyesi basıncı (eş basınç çizgileriyle), yağış (saatlik, birikimli, yağmur, konvektif, ızgara ölçekli), kar,
  bulutluluk (alçak, orta, yüksek, toplam), radar, CAPE, CIN, kaldırma indeksi, 0–6 km rüzgâr kayması, donma
  seviyesi, jeopotansiyel yükseklik, kar derinliği, toprak nemi, deniz yüzeyi ve deri sıcaklığı, sınır tabaka
  yüksekliği. Seçili katmana yeniden tıklayınca seçenek kutusu açılır: seviye (yüzey, 925 … 250 hPa), rüzgâr
  parçacıkları, rüzgâr okları, eş değer çizgileri, şehirler.
- **Zaman çubuğu:** ◀ ▶ ya da klavyede **←** **→**, oynatmak için **Boşluk**. Saatler Türkiye saatidir
  ("Pzt 14:00 (TSİ)"); birim düğmesinden UTC ya da tarayıcı saatine geçebilirsiniz.
- **Fare ile üzerine gelince** o noktadaki değer görünür.
- **Tıklayınca** nokta kartı açılır: modelin en yakın ızgara noktasındaki değerler, **meteogram** (sıcaklık ve çiy
  noktası, rüzgâr ve hamle, yağış, basınç ve bulutluluk) ve **Skew-T** diyagramı. "Bu noktayı kaydet" ile noktayı
  **Noktalar** sekmesine ekleyebilirsiniz.
- **Arama kutusu** ile şehir bulabilirsiniz.
- **Birimler:** °C/°F, m/s, km/sa, knot, Bofor, hPa/mmHg, mm/inç. Seçimler bu tarayıcıda saklanır.
- **Tema:** koyu ya da açık (ay düğmesi). **Dil:** Türkçe ya da İngilizce.
- **Bağlantıyı kopyala:** adres açık çalışmayı, katmanı, seviyeyi, kareyi ve harita görünümünü taşır.

## Çalışmalar

**Çalışmalar** sekmesinde her tahmin vardır: kip, ızgara, fizik, CPPWRF sürümü, tahmin ve gerçek süre, diskte
kapladığı yer. Düğmeler:

- **Aç**, **Karşılaştır** (iki çalışmayı yan yana, sürüklenebilir bir çizgiyle, ya da farkını A − B olarak),
- **↻** aynı ayarlarla tekrar çalıştır, **✎** ayarları değiştirip çalıştır,
- **★** yıldızla: yıldızlı çalışmalar otomatik temizlikte silinmez,
- **Sil**.

Eski çalışmalar kendiliğinden silinir (en yeni 12 tanesi kalır; yıldızlılar hiç silinmez). Disk her indirme ve
çalışmadan önce denetlenir; 15 GB'ın altına inilmez.

## Dışa aktarma

İndirme düğmesi: haritanın görüntüsü (PNG), tüm karelerin animasyonu (WebM), açık katmanın GeoTIFF dosyası
(float32, WGS 84; QGIS ile açılır) ve modelin wrfout dosyaları.

## Sık karşılaşılan hatalar

| Mesaj | Ne yapmalı |
|---|---|
| "GFS … çevriminin N. saati NOMADS'ta yok" | Çevrim henüz tam yayımlanmamış ya da arşivden kalkmış; daha eski bir çevrim seçin. |
| "GFS indirilemedi (ağ hatası, 3 deneme)" | İnternet bağlantısını denetleyip tekrar çalıştırın. |
| "Model kararsızlaştı (sayısal patlama, CFL)" | Zaman adımını küçültün ya da uyarlanır zaman adımını açın. |
| "GPU belleği yetmedi" | Alanı küçültün, dx'i büyütün ya da GPU · FP32 kipini seçin. |
| "Diskte 15 GB'tan az boş yer kaldı" | Eski çalışmaları silin. |
| Ayarın altında kırmızı çevirici hatası | Bu seçenek birleşimi CPPWRF'de yok; başka bir değer seçin. |

## Ürünlerin hesaplanışı

Basınç seviyeleri ln p'de doğrusal aradeğerlemeyle, deniz seviyesi basıncı wrf-python'un yöntemiyle, çiy noktası
Bolton formülüyle, CAPE/CIN psödoadiyabatik parsel ve sanal sıcaklık düzeltmesiyle, hamle UPP'nin CALGUST
yöntemiyle, bulutluluk ISCCP basınç bantlarıyla hesaplanır. Ayrıntılar sayfanın **Yardım** bölümünde ve
[FORECAST.md](FORECAST.md) dosyasındadır.

# Flashcard tiếng Anh (realtime)

- **Học** (`#hoc`): tranh hiện 10s → từ mới hiện đè lên tranh 10s → sang thẻ tiếp. Trước/sau, phát/dừng, trộn, toàn màn hình, lọc chủ đề.
  Zoom: nút `+ − 1×`, lăn chuột, chụm 2 ngón trên điện thoại, kéo để di chuyển. Khi phóng to sẽ tự tạm dừng.
- **Tạo thẻ** (`#quan-ly`): đăng nhập → kéo thả / chọn / dán (Ctrl+V) ảnh, nhập từ mới, chủ đề → Lưu.
  Sửa từ, đổi thứ tự, xoá thẻ. Mọi thay đổi hiện ngay trên mọi máy đang mở trang Học (realtime).

Dữ liệu (ảnh + từ) lưu trên **Supabase** (miễn phí). Web là trang tĩnh, đưa lên GitHub Pages được.

## Cài đặt (làm 1 lần, ~10 phút)

### 1. Tạo project Supabase
1. Đăng ký tại https://supabase.com → **New project**.
2. Vào **SQL Editor** → dán toàn bộ nội dung `supabase/setup.sql` → **Run**.
   (Tạo bảng `cards`, bật realtime, tạo kho ảnh `flashcards` và phân quyền.)

### 2. Tạo tài khoản quản lý
1. **Authentication → Users → Add user → Create new user**: nhập email + mật khẩu, tick *Auto Confirm User*.
2. Nên tắt đăng ký tự do: **Authentication → Sign In / Providers** → tắt *Allow new users to sign up*.
   Như vậy chỉ tài khoản bạn tạo mới thêm/sửa thẻ được, học sinh chỉ xem.

### 3. Điền cấu hình
**Project Settings → API** (hoặc *API Keys*), copy:
- Project URL → `SUPABASE_URL`
- anon / publishable key → `SUPABASE_KEY`

rồi dán vào `config.js`. Key này được phép công khai (quyền đã khoá bằng RLS trong setup.sql).
**Không** dùng key `service_role` / secret.

### 4. Đưa lên GitHub Pages
1. Push code lên repo (nhánh `main`).
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main` / `(root)` → Save.
3. Sau ~1 phút: `https://<user>.github.io/<repo>/`
   - Học: `.../#hoc`
   - Tạo thẻ: `.../#quan-ly`

Sau bước này, thêm thẻ trực tiếp trên web, **không cần push code nữa**.

## Chạy thử trên máy
```bash
npx serve .        # hoặc: python -m http.server 8000
```

## Cấu trúc
```
index.html          # giao diện 2 module
style.css
app.js              # logic: player, zoom, realtime, upload
config.js           # URL + key Supabase
supabase/setup.sql  # tạo bảng, kho ảnh, phân quyền
```

## Phím tắt (tab Học)
← / → chuyển thẻ · Space phát/dừng · F toàn màn hình · + / − / 0 zoom

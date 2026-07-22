// Cấu hình Tailwind Play CDN dùng chung (nạp SAU thẻ script cdn.tailwindcss.com).
// Giữ 1 nơi để đồng bộ màu brand + font cho toàn bộ trang admin.
window.tailwind = window.tailwind || {};
window.tailwind.config = {
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          500: "#1877f2",
          600: "#1466d8",
          700: "#0f52ad"
        },
        ig: {
          500: "#d6249f",
          600: "#b8228c"
        }
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "-apple-system", "sans-serif"]
      }
    }
  }
};

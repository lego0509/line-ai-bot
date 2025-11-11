export default async function handler(req, res) {
  try {
    // リクエスト確認
    console.log("Method:", req.method);
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);

    if (req.method === "POST") {
      res.status(200).json({ message: "POST received", body: req.body });
    } else {
      res.status(200).json({ message: "GET request working fine" });
    }
  } catch (err) {
    console.error("Error caught:", err);
    res.status(500).json({ error: err.message });
  }
}

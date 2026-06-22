const express = require("express");

const router = express.Router();

router.get("/me", (req, res) => {
  const { id, name } = req.session.facebookUser;

  res.json({
    success: true,
    user: {
      id,
      name
    }
  });
});

module.exports = router;

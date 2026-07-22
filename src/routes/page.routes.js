const express = require("express");

const facebookService = require("../services/facebook.service");
const pageVisibilityService = require("../services/page-visibility.service");

const router = express.Router();

router.get("/pages", (req, res) => {
  const pages = pageVisibilityService
    .getVisiblePages(req.session.facebookUser.pages)
    .map((page) => ({
      id: page.id,
      name: page.name,
      pictureUrl: page.pictureUrl,
      canCreateContent: facebookService.canCreateContent(page),
      instagramBusinessAccount: page.instagramBusinessAccount || null
    }));

  res.json({
    success: true,
    pageCount: pages.length,
    pages
  });
});

module.exports = router;

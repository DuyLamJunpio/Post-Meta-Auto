const crypto = require("crypto");
const express = require("express");

const { config } = require("../config");
const facebookService = require("../services/facebook.service");
const googleDriveService = require("../services/google-drive.service");
const gbpService = require("../services/gbp.service");
const instagramService = require("../services/instagram.service");
const tiktokService = require("../services/tiktok.service");
const userFacebookService = require("../services/user-facebook.service");

const router = express.Router();

function requireFacebookLogin(req, res, next) {
  if (!req.session || !req.session.facebookUser) {
    return res.redirect("/");
  }

  next();
}

router.get("/facebook", (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");
  req.session.facebookOAuthState = state;

  const params = new URLSearchParams({
    client_id: config.facebook.appId,
    redirect_uri: config.facebook.redirectUri,
    scope: config.facebook.scopes.join(","),
    state,
    response_type: "code",
    // Buộc Facebook hỏi lại các quyền người dùng đã từng từ chối (vd pages_read_engagement),
    // thay vì bỏ qua âm thầm -> tránh trường hợp token thiếu quyền đọc bài Page.
    auth_type: "rerequest"
  });

  res.redirect(`${config.facebook.oauthDialogUrl}?${params.toString()}`);
});

router.get("/facebook/callback", async (req, res, next) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;
    const expectedState = req.session.facebookOAuthState;

    delete req.session.facebookOAuthState;

    if (error) {
      return res.status(400).send(errorDescription || "Facebook đã hủy yêu cầu đăng nhập.");
    }

    if (!expectedState || state !== expectedState) {
      return res.status(400).send("OAuth state không hợp lệ.");
    }

    if (!code) {
      return res.status(400).send("Không có authorization code.");
    }

    const userAccessToken = await facebookService.exchangeCodeForUserAccessToken(code);
    const facebookUser = await facebookService.getFacebookUser(userAccessToken);
    const pages = await facebookService.getManagedPages(userAccessToken);

    req.session.facebookUser = {
      id: facebookUser.id,
      name: facebookUser.name,
      userAccessToken,
      pages
    };

    // Pha 2: nếu đang đăng nhập tài khoản (userId) -> lưu kết nối FB theo user vào Postgres.
    // Additive: luồng admin (không có userId) không đổi.
    if (req.session.userId) {
      try {
        await userFacebookService.saveConnection(req.session.userId, req.session.facebookUser);
      } catch (persistError) {
        console.error("[User FB] Lưu kết nối theo tài khoản thất bại:", persistError.message);
      }
    }

    req.session.save((saveError) => {
      if (saveError) {
        return next(saveError);
      }

      res.redirect("/dashboard.html");
    });
  } catch (error) {
    next(error);
  }
});

router.get("/google/drive", requireFacebookLogin, (req, res, next) => {
  try {
    res.redirect(googleDriveService.buildAuthorizationUrl(req.session));
  } catch (error) {
    next(error);
  }
});

async function handleGoogleDriveCallback(req, res, next) {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;
    const expectedState = req.session.googleDriveOAuthState;

    delete req.session.googleDriveOAuthState;

    if (error) {
      return res.status(400).send(errorDescription || "Google đã hủy yêu cầu kết nối Drive.");
    }

    if (!expectedState || state !== expectedState) {
      return res.status(400).send("OAuth state Google Drive không hợp lệ.");
    }

    if (!code) {
      return res.status(400).send("Không có authorization code Google Drive.");
    }

    const tokens = await googleDriveService.exchangeCodeForTokens(code);
    googleDriveService.storeTokens(req.session, tokens);

    req.session.save((saveError) => {
      if (saveError) {
        return next(saveError);
      }

      res.redirect("/dashboard.html?drive=connected");
    });
  } catch (error) {
    next(error);
  }
}

router.get("/google/drive/callback", requireFacebookLogin, handleGoogleDriveCallback);
router.get("/google/callback", requireFacebookLogin, handleGoogleDriveCallback);

router.get("/google/business", requireFacebookLogin, (req, res, next) => {
  try {
    res.redirect(gbpService.buildAuthorizationUrl(req.session));
  } catch (error) {
    next(error);
  }
});

router.get("/google/business/callback", requireFacebookLogin, async (req, res, next) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;
    const expectedState = req.session.googleBusinessOAuthState;

    delete req.session.googleBusinessOAuthState;

    if (error) {
      return res.status(400).send(errorDescription || "Google đã hủy yêu cầu kết nối Business Profile.");
    }

    if (!expectedState || state !== expectedState) {
      return res.status(400).send("OAuth state Google Business Profile không hợp lệ.");
    }

    if (!code) {
      return res.status(400).send("Không có authorization code Google Business Profile.");
    }

    const tokens = await gbpService.exchangeCodeForTokens(code);
    gbpService.storeTokens(req.session, tokens);

    req.session.save((saveError) => {
      if (saveError) {
        return next(saveError);
      }

      res.redirect("/dashboard.html?gbp=connected");
    });
  } catch (callbackError) {
    next(callbackError);
  }
});

router.get("/instagram", requireFacebookLogin, (req, res, next) => {
  try {
    res.redirect(instagramService.buildAuthorizationUrl(req.session));
  } catch (error) {
    next(error);
  }
});

router.get("/instagram/callback", requireFacebookLogin, async (req, res, next) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;
    const expectedState = req.session.instagramOAuthState;

    delete req.session.instagramOAuthState;

    if (error) {
      return res.status(400).send(errorDescription || "Instagram đã hủy yêu cầu kết nối.");
    }

    if (!expectedState || state !== expectedState) {
      return res.status(400).send("OAuth state Instagram không hợp lệ.");
    }

    if (!code) {
      return res.status(400).send("Không có authorization code Instagram.");
    }

    const tokens = await instagramService.exchangeCodeForTokens(code);
    const profile = await instagramService.getProfile(tokens.accessToken);
    instagramService.storeTokens(req.session, tokens, profile);

    req.session.save((saveError) => {
      if (saveError) {
        return next(saveError);
      }

      res.redirect("/dashboard.html?instagram=connected");
    });
  } catch (callbackError) {
    next(callbackError);
  }
});

router.get("/tiktok", requireFacebookLogin, (req, res, next) => {
  try {
    res.redirect(tiktokService.buildAuthorizationUrl(req.session));
  } catch (error) {
    next(error);
  }
});

router.get("/tiktok/callback", requireFacebookLogin, async (req, res, next) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;
    const expectedState = req.session.tiktokOAuthState;

    delete req.session.tiktokOAuthState;

    if (error) {
      return res.status(400).send(errorDescription || "TikTok đã hủy yêu cầu kết nối.");
    }

    if (!expectedState || state !== expectedState) {
      return res.status(400).send("OAuth state TikTok không hợp lệ.");
    }

    if (!code) {
      return res.status(400).send("Không có authorization code TikTok.");
    }

    const tokens = await tiktokService.exchangeCodeForTokens(code);
    const profile = await tiktokService.getProfile(tokens.access_token);
    tiktokService.storeTokens(req.session, tokens, profile);

    req.session.save((saveError) => {
      if (saveError) {
        return next(saveError);
      }

      res.redirect("/dashboard.html?tiktok=connected");
    });
  } catch (callbackError) {
    next(callbackError);
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: "Đăng xuất không thành công.",
        details: null
      });
    }

    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

module.exports = router;

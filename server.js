// server.js - Main server file
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
require("dotenv").config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(
    cors({
        origin: [
            "chrome-extension://*",
            "https://lyncx.ai",
            "http://localhost:3000",
        ],
        credentials: true,
    }),
);
app.use(express.json());

// Initialize Firebase Admin (you'll need to add your service account key)
const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
};

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// JWT Middleware for protected routes
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ error: "Access token required" });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            console.log("JWT verification failed:", err.message);
            return res.status(403).json({ error: "Invalid or expired token" });
        }

        req.user = {
            uid: decoded.uid,
            email: decoded.email,
        };
        next();
    });
};

// ROUTES

// Health check
app.get("/api/health", authenticateToken, (req, res) => {
    res.json({
        status: "healthy",
        user: req.user.email,
        timestamp: new Date().toISOString(),
        server: "lyncx-api",
    });
});

// Auth verification
app.get("/api/auth/verify", authenticateToken, (req, res) => {
    res.json({
        valid: true,
        user: req.user,
    });
});

// Logout (invalidate token - you could maintain a blacklist)
app.post("/api/auth/logout", authenticateToken, (req, res) => {
    // In a production app, you'd add this token to a blacklist
    // For now, we'll just acknowledge the logout
    console.log(`User ${req.user.email} logged out`);
    res.json({ message: "Logged out successfully" });
});

// Get user profile
app.get("/api/user/profile", authenticateToken, async (req, res) => {
    try {
        console.log(`📖 Getting profile for: ${req.user.email}`);

        const userDoc = await db.collection("users").doc(req.user.uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const userData = userDoc.data();

        res.json({
            uid: req.user.uid,
            email: req.user.email,
            displayName: userData.displayName,
            photoURL: userData.photoURL,
            plan: userData.plan,
            createdAt: userData.createdAt,
            lastLogin: userData.lastLogin,
        });
    } catch (error) {
        console.error("Error getting user profile:", error);
        res.status(500).json({ error: "Failed to get user profile" });
    }
});

// Create new user
app.post("/api/user/create", authenticateToken, async (req, res) => {
    try {
        const { planType = "trial" } = req.body;

        console.log(
            `🆕 Creating user: ${req.user.email} with plan: ${planType}`,
        );

        // Check if user already exists
        const existingUser = await db
            .collection("users")
            .doc(req.user.uid)
            .get();
        if (existingUser.exists) {
            return res.status(409).json({ error: "User already exists" });
        }

        const now = new Date();
        let subscriptionEnd = null;

        // Set subscription end based on plan type
        if (planType === "trial") {
            subscriptionEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        }

        const newUserData = {
            uid: req.user.uid,
            email: req.user.email,
            displayName: null,
            photoURL: null,
            plan: {
                type: planType,
                status: "active",
                subscriptionStart: now.toISOString(),
                subscriptionEnd: subscriptionEnd
                    ? subscriptionEnd.toISOString()
                    : null,
                lastUpdated: now.toISOString(),
            },
            createdAt: now.toISOString(),
            lastLogin: now.toISOString(),
        };

        await db.collection("users").doc(req.user.uid).set(newUserData);

        console.log(`✅ User created successfully with ${planType} plan`);

        res.status(201).json({
            message: "User created successfully",
            user: newUserData,
        });
    } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).json({ error: "Failed to create user" });
    }
});

// Update user plan
app.put("/api/user/plan", authenticateToken, async (req, res) => {
    try {
        const { planType, subscriptionEnd, stripeCustomerId } = req.body;

        console.log(`📝 Updating plan for ${req.user.email} to ${planType}`);

        // Validate plan type
        const validPlans = ["free", "trial", "pro", "plus"];
        if (!validPlans.includes(planType)) {
            return res.status(400).json({ error: "Invalid plan type" });
        }

        const now = new Date();
        const updatedPlan = {
            type: planType,
            status: "active",
            subscriptionStart: now.toISOString(),
            subscriptionEnd: subscriptionEnd || null,
            stripeCustomerId: stripeCustomerId || null,
            lastUpdated: now.toISOString(),
        };

        // Update user document
        await db.collection("users").doc(req.user.uid).update({
            plan: updatedPlan,
            lastLogin: now.toISOString(),
        });

        console.log(`✅ Plan updated to ${planType}`);

        res.json({
            message: "Plan updated successfully",
            plan: updatedPlan,
        });
    } catch (error) {
        console.error("Error updating plan:", error);
        res.status(500).json({ error: "Failed to update plan" });
    }
});

// Update user profile
app.put("/api/user/profile", authenticateToken, async (req, res) => {
    try {
        const { displayName, photoURL } = req.body;

        console.log(`👤 Updating profile for ${req.user.email}`);

        const updates = {
            lastLogin: new Date().toISOString(),
        };

        if (displayName !== undefined) updates.displayName = displayName;
        if (photoURL !== undefined) updates.photoURL = photoURL;

        await db.collection("users").doc(req.user.uid).update(updates);

        res.json({
            message: "Profile updated successfully",
        });
    } catch (error) {
        console.error("Error updating profile:", error);
        res.status(500).json({ error: "Failed to update profile" });
    }
});

// Get user stats (example additional endpoint)
app.get("/api/user/stats", authenticateToken, async (req, res) => {
    try {
        const userDoc = await db.collection("users").doc(req.user.uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const userData = userDoc.data();
        const plan = userData.plan;

        // Calculate days remaining
        let daysRemaining = null;
        if (plan.subscriptionEnd) {
            const msRemaining =
                new Date(plan.subscriptionEnd).getTime() - Date.now();
            daysRemaining = Math.max(
                0,
                Math.ceil(msRemaining / (1000 * 60 * 60 * 24)),
            );
        }

        res.json({
            planType: plan.type,
            planStatus: plan.status,
            daysRemaining,
            isExpired: plan.subscriptionEnd
                ? new Date() > new Date(plan.subscriptionEnd)
                : false,
            memberSince: userData.createdAt,
        });
    } catch (error) {
        console.error("Error getting user stats:", error);
        res.status(500).json({ error: "Failed to get user stats" });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
});

// 404 handler
app.use("*", (req, res) => {
    res.status(404).json({ error: "Endpoint not found" });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📚 API Base URL: http://localhost:${PORT}/api`);
});

// Add this to your server.js file
app.post("/api/auth/generate-token", async (req, res) => {
    try {
        const { uid, email, displayName, photoURL } = req.body;

        if (!uid || !email) {
            return res
                .status(400)
                .json({ error: "Missing required user data" });
        }

        // Generate JWT token
        const token = jwt.sign({ uid, email }, process.env.JWT_SECRET, {
            expiresIn: "7d",
        });

        console.log(`✅ Generated token for extension auth: ${email}`);

        res.json({ token });
    } catch (error) {
        console.error("Error generating auth token:", error);
        res.status(500).json({ error: "Failed to generate token" });
    }
});

module.exports = app;

import express, { Request, Response } from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import mongoose, { Types } from "mongoose";
import { WebSocketServer, WebSocket } from "ws";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI =
    process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/resqalloc?directConnection=true";

app.use(cors());
app.use(express.json());

// ==========================================
// MongoDB Schemas & Models
// ==========================================

const ResourceSchema = new mongoose.Schema({
    callsign: { type: String, required: true },
    type: { type: String, required: true },
    coordinates: { type: [Number], required: true },
    status: {
        type: String,
        enum: ["IDLE", "AVAILABLE", "ASSIGNED", "OUT_OF_SERVICE", "REROUTED"],
        default: "IDLE",
    },
    currentIncidentId: { type: String, default: null },
});

const IncidentSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String, default: "" },
    locationName: { type: String, default: "" },
    coordinates: { type: [Number], required: true },
    severity: { type: Number, default: 1 },
    urgency: { type: String, default: "MEDIUM" },
    requiredResources: { type: [String], default: [] },
    status: {
        type: String,
        enum: ["PENDING", "ASSIGNED", "RESOLVED", "CANCELLED"],
        default: "PENDING",
    },
});

const AssignmentSchema = new mongoose.Schema({
    incidentId: { type: String, required: true },
    resourceId: { type: String, required: true },
    assignedBy: { type: String, required: true },
    status: {
        type: String,
        enum: ["ACTIVE", "COMPLETED", "PREEMPTED", "CANCELLED"],
        default: "ACTIVE",
    },
    createdAt: { type: Date, default: Date.now },
});

const DecisionLogSchema = new mongoose.Schema({
    action: { type: String, required: true },
    actor: { type: String, required: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    reason: { type: String, required: true },
    timestamp: { type: Date, default: Date.now, index: true },
});

export const ResourceModel = mongoose.model("Resource", ResourceSchema);
export const IncidentModel = mongoose.model("Incident", IncidentSchema);
export const AssignmentModel = mongoose.model("Assignment", AssignmentSchema);
export const DecisionLogModel = mongoose.model("DecisionLog", DecisionLogSchema);

// ==========================================
// WebSocket Infrastructure
// ==========================================

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

export const socketService = {
    broadcast: (event: string, data: any) => {
        const payload = JSON.stringify({ event, data });
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    },
};

wss.on("connection", async (ws: WebSocket) => {
    try {
        const state = await getFullState();
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: "STATE_UPDATED", data: state }));
        }
    } catch (err) {
        console.error("Failed to send initial state to client:", err);
    }
});

// Periodic heartbeat to clean broken TCP sockets
const interval = setInterval(() => {
    wss.clients.forEach((ws: any) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on("close", () => clearInterval(interval));

async function getFullState() {
    const [resources, incidents, assignments, logs] = await Promise.all([
        ResourceModel.find().lean(),
        IncidentModel.find().lean(),
        AssignmentModel.find().lean(),
        DecisionLogModel.find().sort({ timestamp: -1 }).limit(50).lean(),
    ]);
    return { resources, incidents, assignments, logs };
}

const safeBroadcastState = async () => {
    try {
        const state = await getFullState();
        socketService.broadcast("STATE_UPDATED", state);
        return state;
    } catch (err) {
        console.error("Error broadcasting updated state:", err);
        return null;
    }
};

const formatError = (err: unknown): string =>
    err instanceof Error ? err.message : "Internal server error";

// ==========================================
// REST Endpoints
// ==========================================

// GET /api/state
app.get("/api/state", async (_req: Request, res: Response) => {
    try {
        const state = await getFullState();
        return res.json({ status: "ok", data: state });
    } catch (err) {
        return res.status(500).json({ error: "Failed to fetch state", details: formatError(err) });
    }
});

// Default demo datasets for automatic seeding
const DEFAULT_DEMO_INCIDENTS = [
    {
        title: "Medical Emergency (Cardiac Arrest)",
        description: "Patient experiencing severe chest pain requiring immediate ALS ambulance intervention.",
        locationName: "Koramangala 5th Block, Bengaluru",
        coordinates: [77.6200, 12.9352],
        severity: 4,
        urgency: "CRITICAL",
        requiredResources: ["ambulance"],
        status: "PENDING",
    },
    {
        title: "Commercial Complex Structural Fire",
        description: "Active electrical fire reported with entrapment risks.",
        locationName: "100ft Rd, Indiranagar, Bengaluru",
        coordinates: [77.6413, 12.9784],
        severity: 4,
        urgency: "HIGH",
        requiredResources: ["fireTruck", "ambulance"],
        status: "PENDING",
    },
    {
        title: "Multi-Vehicle Collision on MG Road",
        description: "High speed collision requiring heavy rescue and paramedic support.",
        locationName: "MG Road Junction, Bengaluru",
        coordinates: [77.6074, 12.9756],
        severity: 5,
        urgency: "CRITICAL",
        requiredResources: ["ambulance", "rescueSquad"],
        status: "PENDING",
    },
];

const DEFAULT_DEMO_RESOURCES = [
    {
        callsign: "Ambulance 01",
        type: "ambulance",
        coordinates: [77.6050, 12.9550],
        status: "IDLE",
        currentIncidentId: null,
    },
    {
        callsign: "Ambulance 02",
        type: "ambulance",
        coordinates: [77.6000, 12.9760],
        status: "IDLE",
        currentIncidentId: null,
    },
    {
        callsign: "Fire Tender 01",
        type: "fireTruck",
        coordinates: [77.6250, 12.9740],
        status: "IDLE",
        currentIncidentId: null,
    },
    {
        callsign: "Rescue Squad 01",
        type: "rescueSquad",
        coordinates: [77.5739, 12.9634],
        status: "IDLE",
        currentIncidentId: null,
    },
];

// POST /api/seed
app.post("/api/seed", async (req: Request, res: Response) => {
    try {
        const body = req.body || {};
        const incidentsToSeed =
            Array.isArray(body.incidents) && body.incidents.length > 0
                ? body.incidents
                : DEFAULT_DEMO_INCIDENTS;
        const resourcesToSeed =
            Array.isArray(body.resources) && body.resources.length > 0
                ? body.resources
                : DEFAULT_DEMO_RESOURCES;

        await Promise.all([
            IncidentModel.deleteMany({}),
            ResourceModel.deleteMany({}),
            AssignmentModel.deleteMany({}),
            DecisionLogModel.deleteMany({}),
        ]);

        const createdIncidents = await IncidentModel.insertMany(incidentsToSeed);
        const createdResources = await ResourceModel.insertMany(resourcesToSeed);

        const state = await safeBroadcastState();
        return res.json({
            message: "DB reset and reseeded successfully",
            incidentsCount: createdIncidents.length,
            resourcesCount: createdResources.length,
            state,
        });
    } catch (err) {
        return res.status(500).json({ error: "Seed failed", details: formatError(err) });
    }
});

// PATCH /api/resources/:id/status
app.patch("/api/resources/:id/status", async (req: Request, res: Response) => {
    const { status } = req.body || {};
    const resourceId = req.params.id;

    if (!status || typeof status !== "string") {
        return res.status(400).json({ error: "Field 'status' must be a valid string." });
    }

    if (typeof resourceId !== "string" || !Types.ObjectId.isValid(resourceId)) {
        return res.status(400).json({ error: "Invalid Resource ObjectId." });
    }

    const session = await mongoose.startSession();
    let updatedResource: any = null;
    let disruptionPayload: any = null;

    try {
        await session.withTransaction(async () => {
            const updateFields: Record<string, any> = { status };
            if (status === "OUT_OF_SERVICE" || status === "AVAILABLE" || status === "IDLE") {
                updateFields.currentIncidentId = null;
            }

            updatedResource = await ResourceModel.findByIdAndUpdate(
                resourceId,
                updateFields,
                { new: true, session }
            );

            if (!updatedResource) {
                throw new Error("NOT_FOUND");
            }

            if (status === "OUT_OF_SERVICE") {
                // Atomically preempt active assignment
                const activeAssignment = await AssignmentModel.findOneAndUpdate(
                    { resourceId: updatedResource._id.toString(), status: "ACTIVE" },
                    { status: "PREEMPTED" },
                    { new: true, session }
                );

                if (activeAssignment) {
                    const affectedIncident = await IncidentModel.findByIdAndUpdate(
                        activeAssignment.incidentId,
                        { status: "PENDING" },
                        { new: true, session }
                    );

                    const [disruptionLog] = await DecisionLogModel.create(
                        [
                            {
                                action: "PREEMPTION",
                                actor: "Backend Authority Sentinel",
                                details: {
                                    resource: updatedResource.callsign,
                                    affectedIncidentId: affectedIncident?._id,
                                },
                                reason: `CRITICAL ALERT: ${updatedResource.callsign} went OUT_OF_SERVICE. Assignment revoked for '${affectedIncident?.title || "Incident"}'. Immediate reassessment required.`,
                            },
                        ],
                        { session }
                    );

                    disruptionPayload = {
                        resource: updatedResource,
                        affectedIncident,
                        disruptionLog,
                    };
                }
            }
        });

        if (disruptionPayload) {
            socketService.broadcast("DISRUPTION_TRIGGERED", disruptionPayload);
        }
        await safeBroadcastState();

        return res.json({ message: "Status updated successfully", resource: updatedResource });
    } catch (err) {
        if (err instanceof Error && err.message === "NOT_FOUND") {
            return res.status(404).json({ error: "Resource not found" });
        }
        return res.status(500).json({ error: "Status update failed", details: formatError(err) });
    } finally {
        await session.endSession();
    }
});

// Reusable atomic dispatch processor
async function executeDispatch(
    incidentId: string,
    proposedResourceId: string,
    actor: string,
    reason: string,
    res: Response
) {
    if (!Types.ObjectId.isValid(incidentId) || !Types.ObjectId.isValid(proposedResourceId)) {
        return res.status(400).json({ error: "Invalid incidentId or proposedResourceId format." });
    }

    const session = await mongoose.startSession();
    let createdAssignment: any = null;
    let dispatchLog: any = null;
    let conflictReason: string = "Resource or incident is unavailable.";

    try {
        await session.withTransaction(async () => {
            // 1. Atomically lock the resource ONLY IF it is not ASSIGNED or OUT_OF_SERVICE
            const resource = await ResourceModel.findOneAndUpdate(
                {
                    _id: proposedResourceId,
                    status: { $nin: ["OUT_OF_SERVICE", "ASSIGNED"] },
                },
                {
                    status: "ASSIGNED",
                    currentIncidentId: incidentId,
                },
                { new: true, session }
            );

            if (!resource) {
                const currentResourceState = await ResourceModel.findById(proposedResourceId).session(session);
                conflictReason = !currentResourceState
                    ? `Resource ${proposedResourceId} does not exist.`
                    : `Authority conflict: Cannot dispatch ${currentResourceState.callsign} because status is ${currentResourceState.status}.`;
                throw new Error("RESOURCE_UNAVAILABLE");
            }

            // 2. Atomically lock the incident ONLY IF it is not already ASSIGNED
            const incident = await IncidentModel.findOneAndUpdate(
                { _id: incidentId, status: { $ne: "ASSIGNED" } },
                { status: "ASSIGNED" },
                { new: true, session }
            );

            if (!incident) {
                conflictReason = "Incident does not exist or has already been assigned.";
                throw new Error("INCIDENT_UNAVAILABLE");
            }

            // 3. Create active assignment record
            const [assignment] = await AssignmentModel.create(
                [
                    {
                        incidentId,
                        resourceId: resource._id.toString(),
                        assignedBy: actor,
                        status: "ACTIVE",
                    },
                ],
                { session }
            );

            // 4. Log the audit decision
            const [log] = await DecisionLogModel.create(
                [
                    {
                        action: "DISPATCH",
                        actor,
                        details: { assignmentId: assignment._id, callsign: resource.callsign },
                        reason,
                    },
                ],
                { session }
            );

            createdAssignment = assignment;
            dispatchLog = log;
        });

        await safeBroadcastState();
        socketService.broadcast("EXPLANATION_EMITTED", dispatchLog);

        return res.status(201).json({ success: true, assignment: createdAssignment, dispatchLog });
    } catch (err) {
        if (
            err instanceof Error &&
            (err.message === "RESOURCE_UNAVAILABLE" || err.message === "INCIDENT_UNAVAILABLE")
        ) {
            // Record conflict in decision log
            try {
                const conflictLog = await DecisionLogModel.create({
                    action: "REJECTED_BY_DB",
                    actor: "Backend Authority Sentinel",
                    details: { proposedResourceId, incidentId },
                    reason: conflictReason,
                });
                socketService.broadcast("DECISION_LOG_ADDED", conflictLog);
            } catch (logErr) {
                console.error("Failed to write conflict audit log:", logErr);
            }

            return res.status(409).json({ success: false, message: conflictReason });
        }
        return res.status(500).json({ error: "Dispatch failed", details: formatError(err) });
    } finally {
        await session.endSession();
    }
}

// POST /api/assignments/validate-and-assign
app.post("/api/assignments/validate-and-assign", async (req: Request, res: Response) => {
    const { incidentId, proposedResourceId, reason } = req.body || {};
    return executeDispatch(
        incidentId,
        proposedResourceId,
        "AI_AGENT",
        reason || "AI agent recommended dispatch approved by system rules.",
        res
    );
});

// POST /api/assignments/approve
app.post("/api/assignments/approve", async (req: Request, res: Response) => {
    const { incidentId, proposedResourceId, rationale, approved } = req.body || {};

    if (approved === false) {
        try {
            const rejectedLog = await DecisionLogModel.create({
                action: "REJECTED_BY_DB",
                actor: "Human Dispatcher",
                details: { incidentId, proposedResourceId },
                reason: rationale || "Dispatcher manually declined AI reassignment proposal.",
            });

            await safeBroadcastState();
            socketService.broadcast("DECISION_LOG_ADDED", rejectedLog);

            return res.json({ message: "Rejected by operator", log: rejectedLog });
        } catch (err) {
            return res.status(500).json({ error: "Rejection logging failed", details: formatError(err) });
        }
    }

    return executeDispatch(
        incidentId,
        proposedResourceId,
        "Human Dispatcher + AI Agent",
        rationale || "Dispatcher approved reassignment to restore emergency coverage.",
        res
    );
});

// ==========================================
// Initialization & Graceful Shutdown
// ==========================================

mongoose
    .connect(MONGO_URI)
    .then(() => {
        console.log("Connected to MongoDB successfully");
        server.listen(PORT, () => {
            console.log(`ResQAlloc WebSocket & HTTP server running on port ${PORT}`);
        });
    })
    .catch((err) => {
        console.error("MongoDB connection failed:", err);
        process.exit(1);
    });

const shutdown = async (signal: string) => {
    console.log(`Received ${signal}. Closing server connections...`);
    server.close(async () => {
        wss.close();
        await mongoose.connection.close(false);
        console.log("Server shutdown complete.");
        process.exit(0);
    });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
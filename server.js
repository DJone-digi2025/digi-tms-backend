import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import supabase from "./db/supabaseClient.js"
import multer from "multer"
import csv from "csv-parser"
import fs from "fs"
import cron from "node-cron"
import AWS from "aws-sdk"

import { generateTasksFromRow, getClients, getTeamMembers } from "./services/taskGenerator.js"

import { runMarketingTaskGenerator } from "./services/marketingTaskGenerator.js";


dotenv.config()


const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: "v4"
});

const app = express()

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const upload = multer({ dest: "uploads/" })

app.use(cors({
  origin: "*"
}))
app.use(express.json())

// test route
app.get("/", (req, res) => {
  res.send("Digi TMS Backend Running")
})

const uploadMemory = multer({ storage: multer.memoryStorage() });

// test database connection
app.get("/test-db", async (req, res) => {
  const { data, error } = await supabase
    .from("clients")
    .select("*")

  if (error) {
    return res.status(500).json(error)
  }

  res.json(data)
})



app.get("/clients", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clients")
      .select("*");

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("🔥 CLIENT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/team", async (req, res) => {
  const { data, error } = await supabase
    .from("team_members")
    .select("*")

  if (error) {
    return res.status(500).json(error)
  }

  res.json(data)
})

app.get("/system-data", async (req, res) => {
  try {
    const clients = await getClients()
    const team = await getTeamMembers()

    res.json({
      clients,
      team
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/billing", async (req, res) => {
  const { data } = await supabase
    .from("billing")
    .select("*")
    .order("id", { ascending: false });
});



app.get("/meetings", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("meetings")
      .select(`
  *,
  creator:users!meetings_created_by_fkey ( name, role )
`)
      .neq("status", "cancelled")
      .order("meeting_date", { ascending: true });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/team-stats", async (req, res) => {
  try {
    const { data: members, error: mError } = await supabase
      .from("team_members")
      .select("*");

    if (mError) throw mError;

    const { data: tasks, error: tError } = await supabase
      .from("tasks")
      .select("*");

    if (tError) throw tError;

    const stats = members.map((m) => {
      const memberTasks = tasks.filter(
        (t) => t.team_member_id === m.id   // ✅ FIXED
      );

      return {
        id: m.id,
        name: m.name,
        skill: m.skill || "N/A",
        total: memberTasks.length,
        pending: memberTasks.filter(
          (t) => t.status !== "completed"
        ).length
      };
    });

    res.json(stats);
  } catch (err) {
    console.error("TEAM STATS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/reassign-task/:id", async (req, res) => {
  try {
    const { new_user_id } = req.body;

    const { error } = await supabase
      .from("tasks")
      .update({ team_member_id: new_user_id }) // ✅ FIXED
      .eq("id", req.params.id);

    if (error) throw error;

    res.json({ message: "Task reassigned successfully" });
  } catch (err) {
    console.error("REASSIGN ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/upload-plan", upload.single("file"), async (req, res) => {

  const { user_name, user_role } = req.body;

  // ✅ AUTH (CLEAN)
  if (user_role !== "manager" && user_role !== "strategist") {
    return res.status(403).json({ error: "Unauthorized upload access" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", async () => {

      try {

        const clients = await getClients();
        const teamMembers = await getTeamMembers();

        console.log("TEAM MEMBERS SENT TO GENERATOR:", teamMembers);

        for (const row of results) {

          // 🔥 VALIDATION
          if (!row.client_name || !row.publish_date || !row.content_type || !row.count) {
            console.log("❌ Skipping invalid row:", row);
            continue;
          }

          const date = new Date(row.publish_date);
          if (isNaN(date)) {
            console.log("❌ Invalid date:", row.publish_date);
            continue;
          }

          const count = parseInt(row.count);
          if (isNaN(count) || count <= 0) {
            console.log("❌ Invalid count:", row.count);
            continue;
          }

          // 🔥 NORMALIZE
          row.client_name = row.client_name.trim();
          row.content_type = row.content_type.trim().toLowerCase();
          row.count = count;

          // 🔥 GENERATE TASKS (NO FILTERING)
          await generateTasksFromRow(row, clients, teamMembers);
        }

        fs.unlinkSync(req.file.path);

        res.json({
          message: "Tasks generated",
          rows_processed: results.length
        });

      } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
      }

    });
});

app.post("/upload-output", uploadMemory.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const fileName = `${Date.now()}-${file.originalname}`;

    const params = {
      Bucket: process.env.R2_BUCKET,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype
    };

    await s3.upload(params).promise();

    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;

    res.json({ url: fileUrl });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

app.post("/save-output", async (req, res) => {
  try {
    const { task_id, output_file } = req.body;

    const { error } = await supabase
      .from("tasks")
      .update({ output_file })
      .eq("id", task_id);

    if (error) throw error;

    res.json({ message: "Saved" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post("/generate-marketing-tasks", async (req, res) => {
  try {

    await runMarketingTaskGenerator();

    res.json({
      message: "Marketing tasks generated successfully"
    });

  } catch (err) {
    console.error("MARKETING GEN ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/create-manual-task", async (req, res) => {
  try {
    const {
      client_name,
      content_type,
      publish_date,
      assigned_to,
      assigned_to_role, // ✅ IMPORTANT
      priority
    } = req.body;

    const type = content_type?.toLowerCase().trim();
    const task_category = "design";
    const normalizedPriority = priority?.toLowerCase() || "high";

    function getAssignDate(publishDate, priority, contentType) {
      const today = new Date();
      const publish = new Date(publishDate);
      const p = priority?.toLowerCase();
      const type = contentType?.toLowerCase().trim();

      const bufferRules = {
        reel: 3,
        post: 3,
        carousel: 3,
        bday: 2
      };

      let assignDate;

      if (p === "high") {
        assignDate = new Date(today);
      } else {
        const buffer = bufferRules[type] || 3;

        assignDate = new Date(publish);
        assignDate.setDate(assignDate.getDate() - buffer);

        if (p === "low") {
          assignDate.setDate(assignDate.getDate() - 1);
        }
      }

      while (assignDate.getDay() === 0) {
        assignDate.setDate(assignDate.getDate() - 1);
      }

      return assignDate.toISOString().split("T")[0];
    }

    // ✅ get selected member
    const { data: member, error: memberError } = await supabase
      .from("team_members")
      .select("id")
      .eq("name", assigned_to)
      .single();

    if (memberError || !member) {
      return res.status(400).json({ error: "User not found" });
    }

    // 🔥 get strategist from client (for designer tasks)
let strategistMember = null;

const { data: clientData } = await supabase
  .from("clients")
  .select("strategist")
  .eq("client_name", client_name)
  .maybeSingle(); // 🔥 IMPORTANT (no error if not found)

if (clientData?.strategist) {
  const { data } = await supabase
    .from("team_members")
    .select("id")
    .eq("name", clientData.strategist)
    .single();

  strategistMember = data;
}



    // ✅ 🔥 CORE FIX — ROLE BASED ASSIGNMENT
    let team_member_id = null;
    let strategist_id = null;
    let plan_filename = null;

    if (assigned_to_role === "designer") {
      team_member_id = member.id;
      strategist_id = strategistMember?.id || null;
    }

    if (assigned_to_role === "strategist") {
      strategist_id = member.id;
      team_member_id = null;

      // ✅ only strategist tasks have plans
      plan_filename = `plan_${client_name}_${content_type}_${publish_date}`;
    }

    // 🔥 GENERATE TASK CODE

    const publish = new Date(publish_date);

    const day = String(publish.getDate()).padStart(2, "0");
    const month = String(publish.getMonth() + 1).padStart(2, "0");

    const datePart = `${month}${day}`;

    // ✅ COUNT EXISTING TASKS
    const { count } = await supabase
      .from("tasks")
      .select("*", { count: "exact", head: true })
      .eq("client_name", client_name)
      .eq("content_type", type)
      .eq("publish_date", publish_date);

    // ✅ SEQUENCE
    const sequence = String((count || 0) + 1).padStart(2, "0");

    // ✅ FORMAT
    const clientCode = client_name.replace(/\s+/g, "").slice(0, 3).toUpperCase();
    const contentCode = type.toUpperCase();

    const task_code = `${clientCode}-${contentCode}-${datePart}-${sequence}`;

    const task = {
      client_name,
      content_type: type,
      task_category,
      publish_date,
      assign_date: getAssignDate(
        publish_date,
        normalizedPriority,
        content_type
      ),
      team_member_id,
      strategist_id,
      priority: normalizedPriority,
      status: "ASSIGNED",
      is_manual: true,
      ready_for_publish: false,
      task_code,
      plan_filename
    };

    const { data, error } = await supabase
      .from("tasks")
      .insert([task])
      .select();

    if (error) throw error;

    res.json({
      message: "Manual task created",
      task: data
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/create-marketing-task", async (req, res) => {
  try {
    const {
      client_name,
      content_type,
      publish_date,
      assigned_to, // Aathi
      priority,
      requires_plan
    } = req.body;

    const type = content_type?.toLowerCase().trim();
    const task_category = "marketing";
    const normalizedPriority = priority?.toLowerCase() || "high";

    // 🔹 assign date logic (reuse same)
    function getAssignDate(publishDate) {
      const publish = new Date(publishDate);
      const assignDate = new Date(publish);

      assignDate.setDate(assignDate.getDate() - 2);

      while (assignDate.getDay() === 0) {
        assignDate.setDate(assignDate.getDate() - 1);
      }

      return assignDate.toISOString().split("T")[0];
    }

    // 🔹 get Aathi ID
    const { data: member, error: memberError } = await supabase
      .from("team_members")
      .select("id")
      .eq("name", assigned_to)
      .single();

    if (memberError || !member) {
      return res.status(400).json({ error: "User not found" });
    }

    // 🔹 generate task_code (same pattern)
    const publish = new Date(publish_date);

    const day = String(publish.getDate()).padStart(2, "0");
    const month = String(publish.getMonth() + 1).padStart(2, "0");

    const datePart = `${month}${day}`;

    const { count } = await supabase
      .from("tasks")
      .select("*", { count: "exact", head: true })
      .eq("client_name", client_name)
      .eq("content_type", type)
      .eq("publish_date", publish_date)
      .eq("task_category", "marketing"); // ✅ important

    const sequence = String((count || 0) + 1).padStart(2, "0");

    const clientCode = client_name.replace(/\s+/g, "").slice(0, 3).toUpperCase();
    const contentCode = type.toUpperCase();

    const task_code = `${clientCode}-${contentCode}-${datePart}-${sequence}`;

    const task = {
      client_name,
      content_type: type,
      task_category,
      publish_date,
      assign_date: getAssignDate(publish_date),
      team_member_id: member.id,
      strategist_id: null, // handled later in flow if needed
      priority: normalizedPriority,
      status: "ASSIGNED",
      is_manual: true,
      task_code,
      requires_plan: requires_plan ?? true
    };

    const { data, error } = await supabase
      .from("tasks")
      .insert([task])
      .select();

    if (error) throw error;

    res.json({
      message: "Marketing manual task created",
      task: data
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/preview-assign-date", (req, res) => {
  try {
    const { publish_date, priority, content_type } = req.body;

    if (!publish_date || !priority || !content_type) {
      return res.json({ assign_date: "" });
    }

    function getAssignDate(publishDate, priority, contentType) {
      const today = new Date();
      const publish = new Date(publishDate);
      const p = priority?.toLowerCase();
      const type = contentType?.toLowerCase().trim();

      const bufferRules = {
        reel: 3,
        post: 3,
        carousel: 3,
        bday: 2
      };

      let assignDate;

      if (p === "high") {
        assignDate = new Date(today);
      } else {
        const buffer = bufferRules[type] || 3;

        assignDate = new Date(publish);
        assignDate.setDate(assignDate.getDate() - buffer);

        if (p === "low") {
          assignDate.setDate(assignDate.getDate() - 1);
        }
      }

      // skip Sunday
      while (assignDate.getDay() === 0) {
        assignDate.setDate(assignDate.getDate() + 1);
      }

      return assignDate.toISOString().split("T")[0];
    }

    const assign_date = getAssignDate(publish_date, priority, content_type);

    res.json({ assign_date });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/cancel-task", async (req, res) => {
  const { task_id } = req.body;

  const { error } = await supabase
    .from("tasks")
    .update({ status: "CANCELLED" })
    .eq("id", task_id);

  if (error) return res.status(500).json({ error });

  res.json({ message: "Task cancelled" });
});

app.post("/create-bill", async (req, res) => {
  try {
    const {
      client_name,
      content_type,
      content_description,
      content_count,
      amount_credited,
      user_id,
      user_name,
      role
    } = req.body;

    // ✅ basic validation
    if (!client_name || !content_type || !amount_credited) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ✅ insert simple log entry (NO calculations)
    const { data, error } = await supabase
      .from("billing")
      .insert([
        {
          client_name,
          content_type,
          content_description,
          content_count,
          amount_credited: Number(amount_credited),

          // 🔥 IMPORTANT
          user_id,
          user_name,
          role,
          logged_by: `${user_name} (${role})`
        }
      ])
      .select();

    if (error) throw error;

    // ✅ activity log (keep this, it's good)
    await supabase.from("activity_logs").insert([
      {
        user_id: user_id || null,
        user_name: user_name || "unknown",
        role: role || "unknown",

        action: "BILL_CREATED",
        module: "billing",

        details: {
          client: client_name,
          amount: amount_credited
        }
      }
    ]);

    res.json({ message: "Bill created", data });

  } catch (err) {
    console.error("CREATE BILL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});


app.post("/create-meeting", async (req, res) => {
  try {
    const { client_name, meeting_date, meeting_time, created_by } = req.body;

    const { data, error } = await supabase
      .from("meetings")
      .insert([
        {
          client_name,
          meeting_date,
          meeting_time,
          created_by: created_by
        }
      ])
      .select(`
  *,
  creator:users!meetings_created_by_fkey ( name, role )
`);

    if (error) throw error;

    res.json({ message: "Meeting created", data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/complete-meeting", async (req, res) => {
  try {
    const { meeting_id } = req.body;

    if (!meeting_id) {
      return res.status(400).json({ error: "meeting_id required" });
    }

    const { data, error } = await supabase
      .from("meetings")
      .update({
        status: "completed"
      })
      .eq("id", meeting_id)
      .select();

    if (error) throw error;

    res.json({
      message: "Meeting marked as completed",
      data
    });

  } catch (err) {
    console.log("COMPLETE MEETING ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/cancel-meeting/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("meetings")
      .update({ status: "cancelled" })
      .eq("id", id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: "Meeting cancelled successfully" });

  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/mark-task-low", async (req, res) => {

  try {

    const { task_id, emergency_task_id } = req.body

    // check if emergency already blocks another task
    const { data: existing } = await supabase
      .from("tasks")
      .select("id")
      .eq("blocked_by_task_id", emergency_task_id)
      .limit(1)

    if (existing && existing.length > 0) {
      return res.status(400).json({
        error: "This emergency task already blocks another task"
      })
    }

    const { data, error } = await supabase
      .from("tasks")
      .update({
        priority: "low",
        blocked_by_task_id: emergency_task_id
      })
      .eq("id", task_id)
      .select()

    if (error) throw error

    res.json({
      message: "Task marked LOW and protected from delay",
      task: data
    })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }

})

app.post("/tasks/pause", async (req, res) => {
  try {
    const { task_ids, pause } = req.body;

    if (!task_ids || !Array.isArray(task_ids)) {
      return res.status(400).json({ error: "task_ids required" });
    }

    const { data, error } = await supabase
      .from("tasks")
      .update({ delay_paused: pause })
      .in("id", task_ids)
      .select();

    if (error) throw error;

    res.json({
      message: pause ? "Tasks paused" : "Tasks resumed",
      data
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/users/pause", async (req, res) => {
  try {
    const { user_ids, pause } = req.body;

    if (!user_ids || !Array.isArray(user_ids)) {
      return res.status(400).json({ error: "user_ids required" });
    }

    const { data, error } = await supabase
      .from("team_members")
      .update({ delay_paused: pause })
      .in("id", user_ids)
      .select();

    if (error) throw error;

    res.json({
      message: pause ? "Users paused" : "Users resumed",
      data
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/tasks/priority-override", async (req, res) => {
  try {
    const { task_id, priority } = req.body;

    if (!task_id) {
      return res.status(400).json({ error: "task_id required" });
    }

    // 🔹 Prepare update object
    let updateData = {};

    if (priority === "high") {
      updateData = {
        priority_override: "high",
        blocked_by_task_id: null // ✅ clear blocking
      };
    } else if (priority === "low") {
      updateData = {
        priority_override: "low"
        // ❌ do NOT touch blocked_by_task_id
      };
    } else if (priority === null) {
      updateData = {
        priority_override: null
      };
    } else {
      return res.status(400).json({ error: "Invalid priority value" });
    }

    const { data, error } = await supabase
      .from("tasks")
      .update(updateData)
      .eq("id", task_id)
      .select();

    if (error) throw error;

    res.json({
      message: "Priority override updated",
      task: data
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/update-plan-link", async (req, res) => {
  try {
    const { task_id, plan_link, plan_file, description } = req.body;

    const updateData = {
      plan_link: plan_link || null,
      plan_file: plan_file || null,
      description: description || null
    };

    const { data, error } = await supabase
      .from("tasks")
      .update(updateData)
      .eq("id", task_id)
      .select();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function updateDelayCounters() {

  try {

    const today = new Date().toISOString().split("T")[0]

    const { data: tasks } = await supabase
      .from("tasks")
      .select("*")
      .neq("status", "COMPLETED")

    // 🔹 FETCH HOLIDAYS
const { data: holidays } = await supabase
  .from("holidays")
  .select("date");

// 🔹 CREATE SET
const holidaySet = new Set(
  holidays.map(h => h.date)
);

    for (const task of tasks) {



        // 🔹 NEW — Task-level pause (ADD HERE)
  if (task.delay_paused) continue;

  // 🔹 NEW — User-level pause (ADD HERE)
// 🔹 User-level pause + leave check
let userPaused = false;

const todayStr = today; // already "YYYY-MM-DD"

if (task.team_member_id) {
  const { data: member } = await supabase
    .from("team_members")
    .select("delay_paused, leave_start_date, leave_end_date")
    .eq("id", task.team_member_id)
    .single();

  if (member) {
    // manual pause
    if (member.delay_paused) userPaused = true;

    // 🔹 leave check
    if (
      member.leave_start_date &&
      member.leave_end_date &&
      todayStr >= member.leave_start_date &&
      todayStr <= member.leave_end_date
    ) {
      userPaused = true;
    }
  }
}

if (!userPaused && task.strategist_id) {
  const { data: strategist } = await supabase
    .from("team_members")
    .select("delay_paused, leave_start_date, leave_end_date")
    .eq("id", task.strategist_id)
    .single();

  if (strategist) {
    if (strategist.delay_paused) userPaused = true;

    // 🔹 leave check
    if (
      strategist.leave_start_date &&
      strategist.leave_end_date &&
      todayStr >= strategist.leave_start_date &&
      todayStr <= strategist.leave_end_date
    ) {
      userPaused = true;
    }
  }
}

if (userPaused) continue;

        // 🔹 NEW: Override low should pause delay
if (task.priority_override === "low") {
  continue;
}

      // skip blocked tasks
      if (task.blocked_by_task_id) {

        const { data: emergency } = await supabase
          .from("tasks")
          .select("status")
          .eq("id", task.blocked_by_task_id)
          .single()

        if (emergency && emergency.status !== "COMPLETED") {
          continue
        }

      }

const assignDate = new Date(task.assign_date);
const todayDate = new Date(today);

let diffDays = 0;
let tempDate = new Date(assignDate);

while (tempDate < todayDate) {
  tempDate.setDate(tempDate.getDate() + 1);

  const day = tempDate.getDay(); // Sunday = 0
  const dateStr = tempDate.toISOString().split("T")[0];

  // 🔹 Skip Sunday
  if (day === 0) continue;

  // 🔹 Skip Holiday ONLY for design stage
  if (task.stage === "design" && holidaySet.has(dateStr)) continue;

  diffDays++;
}

if (diffDays > 0) {
  await supabase
    .from("tasks")
    .update({ delay_days: diffDays })
    .eq("id", task.id);
}

    }

    console.log("Delay counters updated")

  } catch (err) {

    console.error("Delay job error:", err)

  }

}

async function evaluateDesignerBlocks() {

  const { data: designers } = await supabase
    .from("team_members")
    .select("*")
    .eq("role", "designer")

  for (const designer of designers) {

    const { data: delayedTasks } = await supabase
      .from("tasks")
      .select("id")
      .eq("team_member_id", designer.id)
      .gt("delay_days", 3)
      .neq("status", "COMPLETED")

    const delayedCount = delayedTasks.length

    if (delayedCount >= 3) {

      await supabase
        .from("team_members")
        .update({ is_blocked: true })
        .eq("id", designer.id)

    } else {

      await supabase
        .from("team_members")
        .update({ is_blocked: false })
        .eq("id", designer.id)

    }

  }

}

cron.schedule("0 0 * * *", async () => {
  console.log("⏰ Running midnight jobs");

  try {
    await updateDelayCounters();
    await evaluateDesignerBlocks();
    await runMarketingTaskGenerator();

    console.log("✅ All cron jobs completed");
  } catch (err) {
    console.error("❌ Cron error:", err.message);
  }

}, {
  timezone: "Asia/Kolkata"
});

app.get("/tasks/manager", async (req, res) => {
  try {
    const {
      page,
      priority,
      assigned_to,
      client_name,
      publish_date   // ✅ ADDED
    } = req.query;

    let query = supabase
      .from("tasks")
      .select(`
        *,
        team_members!tasks_team_member_id_fkey ( name ),
        strategist:team_members!tasks_strategist_id_fkey ( name )
      `)

    // ===== PAGE FILTER =====
    if (!page || page === "tasks") {
      query = query.neq("status", "CANCELLED");
    }
    else if (page === "evaluation") {
      query = query.in("status", ["SUBMITTED", "REWORK"]);
    }
    else if (page === "history") {
      query = query
      .eq("status", "COMPLETED")
      .eq("ready_for_publish", false);
    }

    // ===== PRIORITY FILTER (FIXED) =====
    if (priority) {
      query = query.eq("priority", priority.toLowerCase());
    }

    // ===== CLIENT FILTER =====
    if (client_name) {
      query = query.ilike("client_name", `%${client_name}%`);
    }

    // ===== DATE FILTER (NEW) =====
    if (publish_date) {
      query = query.eq("publish_date", publish_date);
    }

    // ===== MEMBER FILTER =====
    if (assigned_to) {
      const { data: member } = await supabase
        .from("team_members")
        .select("id")
        .eq("name", assigned_to)
        .single();

      if (!member) {
        return res.json([]);
      }

      query = query.eq("team_member_id", member.id);
    }

    const { data, error } = await query.order("publish_date", { ascending: true }).order("id", { ascending: true });

    let filteredData = data;

    // 🔥 FILTER FOR MANAGER TASKS PAGE
    if (!page || page === "tasks") {
    filteredData = data.filter(task => {

      // ❌ remove final completed
      if (
        task.stage === "publish" &&
        task.status === "COMPLETED" &&
        task.ready_for_publish === false
      ) return false;

      // ✅ allow everything else
      return (
        task.status === "ASSIGNED" ||
        task.status === "SUBMITTED" ||
        task.status === "REWORK" ||
        (task.stage === "publish" && task.ready_for_publish === true) ||
        (task.stage === "publish" && task.status === "SUBMITTED")
      );
    });
    }

    if (error) throw error;

    res.json(filteredData);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.post("/submit-task", async (req, res) => {
  console.log("🔥 API HIT", req.body);
  try {
    const { task_id, reason_for_delay } = req.body;

    const { data: task } = await supabase
      .from("tasks")
      .select("assign_date, reason_for_delay")
      .eq("id", task_id)
      .single();

    const today = new Date();
    const assignDate = new Date(task.assign_date);

    let isDelayed = false;

    if (assignDate) {
      assignDate.setHours(0,0,0,0);
      today.setHours(0,0,0,0);
      isDelayed = today > assignDate;
    }

const finalReason = reason_for_delay || task.reason_for_delay;

if (false && isDelayed && (!finalReason || finalReason.trim() === "")) {
  return res.status(400).json({
    error: "Delay reason required"
  });
}

    const updateData = {
      status: "SUBMITTED",
      reason_for_delay: reason_for_delay || null,
      submitted_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from("tasks")
      .update(updateData)
      .eq("id", task_id)
      .select();

    if (error) throw error;

    res.json({
      message: "Task submitted successfully",
      task: data
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/approve-task", async (req, res) => {
  try {
    const { task_id } = req.body;

    // 🔍 get current task
    const { data: task } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", task_id)
      .single();

    let updateData = {};

    // ✅ CASE 1: Designer completed → move to strategist
    if (task.stage === "design") {
      updateData = {
        status: "COMPLETED",
        ready_for_publish: true,
        stage: "publish"
      };
    }

    // ✅ CASE 2: Strategist published → final completion
    else if (task.stage === "publish") {
      updateData = {
        status: "COMPLETED",
        ready_for_publish: false, // 🔥 IMPORTANT
        completed_at: new Date().toISOString()
      };
    }

    const { data, error } = await supabase
      .from("tasks")
      .update(updateData)
      .eq("id", task_id)
      .select();

    if (error) throw error;

    res.json({
      message: "Task approved",
      task: data
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/rework-task", async (req, res) => {

  try {

    const { task_id, manager_comment } = req.body

    const updateData = {
      status: "REWORK"
    }

    // only add comment if provided
    if (manager_comment && manager_comment.trim() !== "") {
      updateData.manager_comment = manager_comment
    }

    const { data, error } = await supabase
      .from("tasks")
      .update(updateData)
      .eq("id", task_id)
      .select()

    if (error) throw error

    res.json({
      message: "Task marked for rework",
      task: data
    })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }

})

app.post("/add-manager-comment", async (req, res) => {

  try {

    const { task_id, manager_comment } = req.body

    const { data, error } = await supabase
      .from("tasks")
      .update({
        manager_comment
      })
      .eq("id", task_id)
      .select()

    if (error) throw error

    res.json({
      message: "Comment saved",
      task: data
    })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }

})

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data: user, error } = await supabase
      .from("team_members")
      .select("*")
      .eq("email", email)
      .eq("password", password)
      .single();

    if (error || !user) {
      return res.status(401).json({
        error: "Invalid credentials"
      });
    }

    // block check
    if (user.is_blocked) {
      return res.status(403).json({
        error: "Account blocked due to delayed tasks"
      });
    }

    res.json({
      id: user.id,
      name: user.name,
      role: user.role,
      access_type: user.access_type
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/dashboard/manager", async (req, res) => {

  try {

    const { client_name } = req.query

    let baseQuery = supabase
      .from("tasks")
      .select("status")

    if (client_name) {
      baseQuery = baseQuery.ilike("client_name", `%${client_name}%`)
    }

    const { data, error } = await baseQuery

    if (error) throw error

    let assigned = 0
    let submitted = 0
    let completed = 0

    for (const task of data) {
      if (task.status === "ASSIGNED") assigned++
      else if (task.status === "SUBMITTED") submitted++
      else if (task.status === "COMPLETED") completed++
    }

    res.json({
      assigned,
      submitted,
      completed
    })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }

})

app.get("/dashboard/common/:id", async (req, res) => {

  try {

    const { id } = req.params

    const { data, error } = await supabase
      .from("tasks")
      .select("status, delay_days")
      .eq("team_member_id", id)

    if (error) throw error

    let assigned = 0
    let submitted = 0
    let completed = 0
    let delayed = 0

    for (const task of data) {

      if (task.status === "ASSIGNED") assigned++
      else if (task.status === "SUBMITTED") submitted++
      else if (task.status === "COMPLETED") completed++

      if (task.delay_days && task.delay_days > 0) {
        delayed++
      }

    }

    res.json({
      assigned,
      submitted,
      completed,
      delayed
    })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }

})

app.get("/team-members", async (req, res) => {

  try {

    const { data, error } = await supabase
      .from("team_members")
      .select("id, name, role")

    if (error) throw error

    res.json(data)

  } catch (err) {
    res.status(500).json({ error: err.message })
  }

})

app.get("/tasks/designer/active", async (req, res) => {
  try {
    const { user_id, user_role } = req.query;

    let data, error;

    const today = new Date().toISOString().split("T")[0];

    // ✅ DESIGNER
    if (user_role === "designer") {
      const response = await supabase
        .from("tasks")
        .select("*")
        .eq("team_member_id", user_id)
        .in("status", ["ASSIGNED", "SUBMITTED", "REWORK"]);

      data = response.data;
      error = response.error;

      if (error) throw error;

      // 🔥 SAFE FILTER
      data = data.filter(task => {
        if (!task.assign_date) return true;
        return task.assign_date <= today;
      });
    }

    // ✅ MARKETING
    else if (user_role === "marketing") {
      const response = await supabase
        .from("tasks")
        .select("*")
        .eq("team_member_id", user_id)
        .eq("task_category", "marketing")
        .in("status", ["ASSIGNED", "SUBMITTED", "REWORK"]);

      data = response.data;
      error = response.error;

      if (error) throw error;

      data = data.filter(task => task.assign_date <= today);
    }

    // ✅ STRATEGIST
    else if (user_role === "strategist") {
      const response = await supabase
        .from("tasks")
        .select("*")
        .eq("strategist_id", user_id);

      data = response.data;
      error = response.error;

      if (error) throw error;

data = data.filter(task => {
  if (task.assign_date && task.assign_date > today) return false;

  const status = (task.status || "").toUpperCase();

  // ❌ NEVER show cancelled
  if (status === "CANCELLED") return false;

  // ✅ workflow tasks (highest priority)
  if (task.ready_for_publish === true) return true;

  if (task.stage === "publish") return true;

  // ❌ block designer manual tasks BEFORE approval
  if (
    task.is_manual === true &&
    task.team_member_id !== null &&
    task.ready_for_publish !== true
  ) {
    return false;
  }

  // ✅ manual tasks assigned directly to strategist
  if (task.is_manual === true && task.strategist_id === user_id) {
    return true;
  }

  return false;
});
    }

    res.json(data);

  } catch (err) {
    console.error("DESIGNER ACTIVE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});


app.get("/tasks/designer/history", async (req, res) => {
  try {
    const { user_id, user_name, user_role } = req.query;

    let query = supabase
      .from("tasks")
      .select("*");

    // 🔥 ROLE BASED HISTORY
    if (user_role === "strategist") {
      // strategist history =completed
      query = query
        .eq("strategist_id", user_id)
        .eq("status", "COMPLETED")
        .eq("stage","publish")
        .eq("ready_for_publish", false);

    } else if (user_role === "manager") {
      // manager history = completed 
      query = query
        .in("status", ["COMPLETED"]);

    } else {
      // designer history = completed
      query = query
        .eq("team_member_id", user_id)
        .eq("status", "COMPLETED");
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/tasks/manager/history", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tasks")
  .select(`
    *,
    team_members!tasks_team_member_id_fkey ( name ),
    strategist:team_members!tasks_strategist_id_fkey ( name )
  `)
      .in("status", ["COMPLETED"]);

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/tasks/designer/all", async (req, res) => {
  const { user_id } = req.query;

  try {
    const { data, error } = await supabase
      .from("tasks")
      .select(`
        *,
        team_members!tasks_team_member_id_fkey ( name )
      `)
      .eq("team_member_id", user_id); // only designer tasks

    if (error) throw error;

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/tasks/all", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tasks")
      .select(`
        *,
        team_members!tasks_team_member_id_fkey ( name ),
        strategist:team_members!tasks_strategist_id_fkey ( name )
      `);

    if (error) throw error;

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/remove-plan/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("tasks")
      .update({
        plan_link: null,
        plan_file: null,
        description: null,
        plan_removed: true
      })
      .eq("id", id);

    if (error) throw error;

    res.json({ message: "Plan removed" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/tasks/:id/save-reason", async (req, res) => {
  try {
    const { id } = req.params;
    const { comment, user_role } = req.body;

    let updateData = {};

    // ✅ ROLE BASED SAVE
if (user_role === "designer" || user_role === "marketing") {
  updateData.reason_for_delay = comment;
}

    if (user_role === "strategist") {
      updateData.strategist_comment = comment;
    }

    const { error } = await supabase
      .from("tasks")
      .update(updateData)
      .eq("id", id);

    if (error) throw error;

    res.json({ message: "Saved" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/tasks/:id/submit", async (req, res) => {
  try {
    const { id } = req.params

    const { data: task } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", id)
      .single()

    const today = new Date().toISOString().split("T")[0]

    const delay_days =
      today > task.publish_date
        ? Math.floor(
            (new Date(today) - new Date(task.publish_date)) /
            (1000 * 60 * 60 * 24)
          )
        : 0

    // VALIDATION
    if (false && delay_days > 0 && !task.reason_for_delay) {
      return res.status(400).json({
        error: "Delay reason required before submit"
      })
    }

    const { error } = await supabase
      .from("tasks")
      .update({
        status: "SUBMITTED",
        submitted_at: new Date().toISOString()
      })
      .eq("id", id)

    if (error) throw error

    res.json({ message: "Submitted successfully" })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/publish-task", async (req, res) => {
  try {
    const { task_id } = req.body;

    const { data, error } = await supabase
      .from("tasks")
      .update({
       
        ready_for_publish: false,
        stage: "publish",
        published_at: new Date().toISOString()
      })
      .eq("id", task_id)
      .select();

    if (error) throw error;

    res.json({
      message: "Task published successfully",
      task: data
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/activity-logs", async (req, res) => {
  try {
    const { user_id, dev_key } = req.query;

    // 🔐 SECOND PROTECTION (FIRST CHECK)
    if (dev_key !== process.env.DEV_KEY) {
      return res.status(403).json({ error: "Invalid developer key" });
    }

    // 🔐 ROLE CHECK (SECOND CHECK)
    const { data: member } = await supabase
      .from("team_members")
      .select("is_super_admin")
      .eq("id", user_id)
      .single();

    if (!member?.is_super_admin) {
      return res.status(403).json({ error: "Access denied" });
    }

    // ✅ FETCH LOGS
    const { data, error } = await supabase
      .from("activity_logs")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
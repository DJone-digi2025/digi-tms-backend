import supabase from "../db/supabaseClient.js";


async function getMarketingStrategistId(name) {
  if (!name) return null;

  const cleanName = name.trim().toLowerCase();

  const { data, error } = await supabase
    .from("team_members")
    .select("id, name");

  console.log("🔍 RULE NAME:", name);
  console.log("🔍 CLEAN NAME:", cleanName);
  console.log("🔍 TEAM MEMBERS:", data);

  if (error || !data) return null;

  const match = data.find(
    m => m.name.trim().toLowerCase() === cleanName
  );

  console.log("✅ MATCH FOUND:", match);

  return match ? match.id : null;
}

// 🔹 Fetch active marketing rules
export async function getActiveMarketingRules() {
  const { data, error } = await supabase
    .from("marketing_rules")
    .select("*")
    .eq("is_active", true);

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// 🔹 Convert day string to JS day index
function getDayIndex(day) {
  const map = {
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6
    // sunday skipped intentionally
  };

  return map[day.toLowerCase()];
}

// 🔹 Generate next 7 days publish dates
export function generatePublishDates(rule) {
  const today = new Date();
  const result = [];

  const frequency = rule.frequency?.toLowerCase();
  const days = rule.days?.split(",").map(d => d.trim().toLowerCase());

  for (let i = 0; i < 7; i++) {
    const date = new Date();
    date.setDate(today.getDate() + i);

    const dayIndex = date.getDay(); // 0 = Sunday

    // ❌ skip Sunday
    if (dayIndex === 0) continue;

    // ✅ DAILY → include all days except Sunday
    if (frequency === "daily") {
      result.push(date.toISOString().split("T")[0]);
    }

    // ✅ WEEKLY → match given days
    if (frequency === "weekly" && days) {
      const match = days.some(d => getDayIndex(d) === dayIndex);
      if (match) {
        result.push(date.toISOString().split("T")[0]);
      }
    }
  }

  return result;
}

// 🔹 Assign date logic (same pattern as manual task)
function getAssignDate(publishDate) {
  const publish = new Date(publishDate);

  // simple buffer (you can tune later)
  const assignDate = new Date(publish);
  assignDate.setDate(assignDate.getDate() - 2);

  // skip Sunday
  while (assignDate.getDay() === 0) {
    assignDate.setDate(assignDate.getDate() - 1);
  }

  return assignDate.toISOString().split("T")[0];
}

function generateTaskCode(client_name, content_type, publish_date) {

  const datePart = publish_date.slice(5).replace("-", ""); // MMDD

  const clientCode = client_name
    .replace(/\s+/g, "")
    .slice(0, 3)
    .toUpperCase();

  const type = content_type.toUpperCase();

  // marketing → always single task → 01
  const countPart = "01";

  return `${clientCode}-${type}-${datePart}-${countPart}`;
}

// 🔹 Build marketing tasks (NO INSERT)
export async function buildMarketingTasks(rule, publishDates) {
  const tasks = [];

  for (const publish_date of publishDates) {

    const strategist_id = await getMarketingStrategistId(rule.marketing_strategist);

    const task = {
      client_name: rule.client_name,
      content_type: rule.content_type.toLowerCase().trim(),

      task_category: "marketing",   // ✅ IMPORTANT
      stage: "design",              // reuse same flow

      publish_date,
      assign_date: getAssignDate(publish_date),

      team_member_id: rule.assigned_to,
      strategist_id: strategist_id,
      strategist: rule.marketing_strategist, // will be filled later (next step)

      status: "ASSIGNED",
      task_code: generateTaskCode(rule.client_name, rule.content_type, publish_date),
      priority: "normal",
      is_manual: false
    };

    tasks.push(task);
  }

  return tasks;
}

export async function insertMarketingTasks(tasks) {

  

  for (const task of tasks) {

    // 🔹 Create unique key (like plan_filename in design)
    const uniqueKey = `${task.client_name}_${task.content_type}_${task.publish_date}`;

    // 🔹 Check duplicate
    const { data: existing } = await supabase
      .from("tasks")
      .select("id")
      .eq("client_name", task.client_name)
      .eq("content_type", task.content_type)
      .eq("publish_date", task.publish_date)
      .eq("task_category", "marketing")
      .limit(1);

    if (existing && existing.length > 0) {
      continue; // skip duplicate
    }
      console.log("🟢 INSERT PAYLOAD:", task);
    // 🔹 Insert
    const { error } = await supabase
      .from("tasks")
      .insert([task]);

    if (error) {
      console.error("Insert error:", error.message);
    }
  }
  
}

export async function runMarketingTaskGenerator() {

  const rules = await getActiveMarketingRules();

  for (const rule of rules) {

    const dates = generatePublishDates(rule);

    const tasks = await buildMarketingTasks(rule, dates);

    await insertMarketingTasks(tasks);
  }

  console.log("✅ Marketing tasks generated");
}
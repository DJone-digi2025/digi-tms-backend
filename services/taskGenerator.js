import supabase from "../db/supabaseClient.js"

const bufferRules = {
  reel: { design: 3, publish: 1 },
  post: { design: 3, publish: 1 },
  carousel: { design: 3, publish: 1 },
  bday: { design: 2, publish: 1}
}

function getPreviousWorkingDay(dateStr, holidays) {
  let d = new Date(dateStr);

  while (true) {
    const day = d.getDay();
    const formatted = d.toISOString().split("T")[0];

    const isSunday = day === 0;

    const isHoliday = holidays.some(h => h.date === formatted);

    if (!isSunday && !isHoliday) {
      return formatted;
    }

    d.setDate(d.getDate() - 1);
  }
}

// get all clients
export async function getClients() {
  const { data, error } = await supabase
    .from("clients")
    .select("*")

  if (error) {
    throw new Error(error.message)
  }

  return data
}

// get all team members
export async function getTeamMembers() {
  const { data, error } = await supabase
    .from("team_members")
    .select("*");

  if (error) {
    throw new Error(error.message);
  }

  console.log("TEAM MEMBERS FROM DB:", data);  // ✅ CORRECT

  return data;
}

// find eligible designers based on rule
export function getEligibleDesigners(rule, contentType, teamMembers) {

  // remove blocked designers
  const todayStr = new Date().toISOString().split("T")[0];

const activeMembers = teamMembers.filter(m => {
  const isOnLeave =
    m.leave_start_date &&
    m.leave_end_date &&
    todayStr >= m.leave_start_date &&
    todayStr <= m.leave_end_date;

  return !m.is_blocked && !isOnLeave;
});

  if (!rule) return []

  // skip task
  if (rule.toLowerCase() === "none") {
    return []
  }

  // auto assign based on skill
  if (rule.toLowerCase() === "auto") {
    return activeMembers.filter(member =>
      member.role?.toLowerCase() === "designer" &&
      member.skill &&
      member.skill?.toLowerCase().includes(contentType)
    )
  }

  // specific designers
const names = rule.split(",").map(n => n.trim().toLowerCase())

return teamMembers.filter(member =>
  member.role?.toLowerCase() === "designer" &&
  names.includes(member.name?.trim().toLowerCase())
)
}

// choose designer with lowest workload for the publish date
export async function pickDesigner(eligibleDesigners) {

  if (eligibleDesigners.length === 0) {
    return null
  }

  let chosen = null
  let minLoad = Infinity

  for (const designer of eligibleDesigners) {

    const { count, error } = await supabase
      .from("tasks")
      .select("*", { count: "exact", head: true })
      .eq("team_member_id", designer.id)
      .neq("status", "COMPLETED")

    if (error) {
      throw new Error(error.message)
    }

    const workload = count || 0

    if (workload < minLoad) {
      minLoad = workload
      chosen = designer
    }

  }

  return chosen
}

// create task in database
export async function createTask(taskData) {

  const { data, error } = await supabase
    .from("tasks")
    .insert([taskData])
    .select()

  if (error) {
    throw new Error(error.message)
  }

  return data
}

export async function generateTasksFromRow(row, clients, teamMembers) {

  const {
    client_name,
    publish_date,
    content_type,
    count
  } = row

  const publishDate = new Date(publish_date)

// 🔥 FETCH HOLIDAYS (once per row)
const { data: holidaysData, error: holidayError } = await supabase
  .from("holidays")
  .select("date");

if (holidayError) {
  console.error("Holiday fetch error:", holidayError.message);
}

const holidays = holidaysData || [];

  console.log("RAW content_type:", content_type);

const type = content_type
  ?.toLowerCase()
  .replace(/\r/g, "")
  .replace(/\n/g, "")
  .trim();

console.log("PROCESSED type:", type);
  const designBuffer = bufferRules[type]?.design

  if (!designBuffer) {
    console.log("Invalid content type:", content_type)
    return
  }

  const assignDate = new Date(publishDate)
  assignDate.setDate(assignDate.getDate() - designBuffer)

  const rawAssignDate = assignDate.toISOString().split("T")[0];

// 🔥 ADJUST TO PREVIOUS WORKING DAY
const formattedAssignDate = getPreviousWorkingDay(rawAssignDate, holidays);

  // find client configuration
  const client = clients.find(
    c => client_name.toLowerCase().includes(c.client_name.toLowerCase())
  )

  // 🔥 MAP STRATEGIST NAME → ID
const strategistMember = teamMembers.find(
  m => m.name.trim().toLowerCase() === client?.strategist?.trim().toLowerCase()
);

console.log("CLIENT:", client_name);
console.log("STRATEGIST NAME:", client?.strategist);
console.log("FOUND STRATEGIST ID:", strategistMember?.id);

  if (!client) {
    console.log("Client not found:", client_name)
    return
  }

  // get rule column
  let rule = null

  if (type === "reel") rule = client.reel_designers
  if (type === "post") rule = client.post_designers
  if (type === "carousel") rule = client.carousel_designers
  if (type === "bday") rule = client.bday_designers

  console.log("RULE SELECTED:", rule);

  const eligible = getEligibleDesigners(rule, type, teamMembers)

if (eligible.length === 0) {
  console.log("Skipping task → eligible empty");
  console.log("Type:", type);
  console.log("Rule:", rule);
  console.log("Team Members:", teamMembers.map(m => ({
    name: m.name,
    role: m.role,
    skill: m.skill
  })));
  return;
}

  for (let i = 1; i <= count; i++) {

    const planFilename = `${client_name.toLowerCase().replace(/\s+/g,"")}_${type}_${publish_date}_${i}`

    // 🔥 DUPLICATE CHECK FIRST
    const { data: existing, error } = await supabase
      .from("tasks")
      .select("id")
      .eq("plan_filename", planFilename)
      .limit(1)

    if (error) {
      console.error("Duplicate check error:", error.message)
      continue
    }

    if (existing && existing.length > 0) {
      console.log("Skipping duplicate task:", planFilename)
      continue
    }

    // 🔥 ONLY NOW pick designer
    

    // ===== TASK CODE GENERATION =====
    const datePart = publish_date.slice(5).replace("-", ""); // MMDD

    const clientCode = client_name
      .replace(/\s+/g, "")
      .slice(0, 3)
      .toUpperCase(); // fallback (safe)

    const taskCode = `${clientCode}-${type.toUpperCase()}-${datePart}-${String(i).padStart(2, "0")}`;

    const task = {
      client_name,
      content_type: type,
      task_category: "design",
      publish_date,
      assign_date: formattedAssignDate,
      team_member_id: null,
      strategist_id: strategistMember?.id || null, 
      status: "PENDING",
      priority: "normal",
      is_manual: false,
      plan_filename: planFilename,
      task_code: taskCode
    }

    await createTask(task)
  }
}

  export async function runDailyAssignment() {

  const today = new Date().toISOString().split("T")[0];

  console.log("Running assignment for:", today);

  // 🔥 get pending tasks for today
  const { data: tasks, error: taskError } = await supabase
    .from("tasks")
    .select("*")
    .eq("status", "PENDING")
    .eq("assign_date", today);

  if (taskError) {
    console.error("Task fetch error:", taskError.message);
    return;
  }

  if (!tasks || tasks.length === 0) {
    console.log("No tasks to assign today");
    return;
  }

  // 🔥 get clients + team
  const clients = await getClients();
  const teamMembers = await getTeamMembers();

  for (const task of tasks) {

    const type = task.content_type;

    const client = clients.find(c =>
      task.client_name.toLowerCase().includes(c.client_name.toLowerCase())
    );

    if (!client) continue;

    let rule = null;

    if (type === "reel") rule = client.reel_designers;
    if (type === "post") rule = client.post_designers;
    if (type === "carousel") rule = client.carousel_designers;
    if (type === "bday") rule = client.bday_designers;

    // 🔥 normal eligible (skill match)
    let eligible = getEligibleDesigners(rule, type, teamMembers);

    // 🔥 fallback if empty
    if (eligible.length === 0) {
      eligible = teamMembers.filter(m =>
        m.role?.toLowerCase() === "designer" &&
        m.active && !m.is_blocked
      );
    }

    if (eligible.length === 0) {
      console.log("No designers available at all");
      continue;
    }

    // 🔥 pick lowest DAILY load
    let chosen = null;
    let minLoad = Infinity;

    for (const designer of eligible) {

      const { count } = await supabase
        .from("tasks")
        .select("*", { count: "exact", head: true })
        .eq("team_member_id", designer.id)
        .eq("assign_date", today);

      const load = count || 0;

      if (load < minLoad) {
        minLoad = load;
        chosen = designer;
      }
    }

    if (!chosen) continue;

    // 🔥 assign
    await supabase
      .from("tasks")
      .update({
        team_member_id: chosen.id,
        status: "ASSIGNED"
      })
      .eq("id", task.id);

    console.log(`Assigned ${task.task_code} → ${chosen.name}`);
  }
}


 
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import mongoose from 'mongoose';

// Reservation Schema for MongoDB
const reservationSchema = new mongoose.Schema({
  bookingId: { type: String, unique: true, required: true },
  reservationStatus: { type: String, required: true },
  customer: String,
  mainGuest: String,
  roomName: String,
  roomType: String,
  roomCategory: { type: String, required: true },
  adult: Number,
  child: Number,
  bookingNumber: String,
  checkin: Date,
  checkout: Date,
  created: Date,
  nights: Number,
  price: Number,
  nightPrice: Number,
  currency: String,
  segment: { type: String, required: true },
  market: String,
  is_cancelled: { type: Number, required: true },
  lead_time_days: { type: Number, required: true }
});

export const Reservation = mongoose.models.Reservation || mongoose.model('Reservation', reservationSchema);

// In-memory fallback database
let fallbackDb = [];
let isMongoConnected = false;

// Helper to parse dates from CSV format (DD-MM-YYYY)
function parseDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // 0-indexed month
    const year = parseInt(parts[2], 10);
    return new Date(Date.UTC(year, month, day));
  }
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? null : date;
}

// Clean and categorize room type
function getRoomCategory(roomType) {
  const rt = String(roomType);
  if (rt.includes('Family') || rt.includes('Familiale')) return 'Family';
  if (rt.includes('Suite')) return 'Suite';
  if (rt.includes('Standard') || rt.toLowerCase().includes('standard')) return 'Standard';
  return 'Autre';
}

// Clean and categorize segment
function getCleanSegment(segment) {
  const s = String(segment).trim().toLowerCase();
  if (s === 'walkin' || s === 'walk-in') return 'WalkIn';
  if (s.includes('ota') || s.includes('online')) return 'OTA';
  if (s === 'b2b') return 'B2B';
  if (['vcr', 'avm', 'crs', 'direct', 'web', 'to'].includes(s)) return s.toUpperCase();
  return 'Other';
}

// Data synchronization and CSV loading
export async function initializeData(mongoConnectedStatus) {
  isMongoConnected = mongoConnectedStatus;
  const csvFilePath = path.join(process.cwd(), '../dailyReport_27-04-2026.csv');
  
  if (!fs.existsSync(csvFilePath)) {
    console.error(`❌ Data CSV file not found at: ${csvFilePath}`);
    return false;
  }

  console.log('🔄 Loading and parsing reservations CSV...');
  const statusFinal = new Set(["CHECKEDOUT", "CANCELLED", "NOSHOW", "EXPIRED"]);
  const results = [];
  let rowCount = 0;

  return new Promise((resolve, reject) => {
    fs.createReadStream(csvFilePath)
      .pipe(csv({ separator: ';' }))
      .on('data', (row) => {
        rowCount++;
        const status = row.reservationStatus ? row.reservationStatus.trim() : '';
        if (!statusFinal.has(status)) return;

        const bookingId = row.id ? row.id.trim() : `temp_${rowCount}`;
        const is_cancelled = ["CANCELLED", "NOSHOW", "EXPIRED"].includes(status) ? 1 : 0;
        
        const checkin = parseDate(row.checkin);
        const created = parseDate(row.created);
        const checkout = parseDate(row.checkout);
        
        if (!checkin || !created) return;

        const lead_time_days = Math.max(0, Math.floor((checkin - created) / (1000 * 60 * 60 * 24)));

        let nights = 1;
        try {
          nights = parseInt(row.nights, 10);
        } catch (e) {}
        if (nights <= 0 || nights > 30) return;

        let price = 1576.0;
        try {
          const rawPrice = row.price ? parseFloat(row.price.replace(',', '.')) : 0;
          if (rawPrice > 0) price = rawPrice;
        } catch (e) {}

        const nightPrice = parseFloat((price / nights).toFixed(2));
        const roomCategory = getRoomCategory(row.roomType);
        const segment = getCleanSegment(row.segment);

        results.push({
          bookingId,
          reservationStatus: status,
          customer: row.customer ? row.customer.trim() : '',
          mainGuest: row.mainGuest ? row.mainGuest.trim() : '',
          roomName: row.roomName ? row.roomName.trim() : '',
          roomType: row.roomType ? row.roomType.trim() : '',
          roomCategory,
          adult: row.adult ? parseInt(row.adult, 10) || 2 : 2,
          child: row.child ? parseInt(row.child, 10) || 0 : 0,
          bookingNumber: row.bookingNumber ? row.bookingNumber.trim() : '',
          checkin,
          checkout,
          created,
          nights,
          price,
          nightPrice,
          currency: row.cyrrency ? row.cyrrency.trim() : 'MAD',
          segment,
          market: row.market ? row.market.trim() : 'unknown',
          is_cancelled,
          lead_time_days
        });
      })
      .on('end', async () => {
        console.log(`✅ Loaded ${results.length} valid final bookings from CSV.`);
        fallbackDb = results;

        if (isMongoConnected) {
          try {
            console.log('🔄 Syncing CSV data with MongoDB...');
            const existingCount = await Reservation.countDocuments();
            if (existingCount === 0) {
              // Batch insertion for performance
              const batchSize = 1000;
              for (let i = 0; i < results.length; i += batchSize) {
                const batch = results.slice(i, i + batchSize);
                await Reservation.insertMany(batch);
              }
              console.log(`✅ MongoDB populated with ${results.length} reservations.`);
            } else {
              console.log(`ℹ️ MongoDB already has ${existingCount} records. Skipping import.`);
            }
          } catch (error) {
            console.error('❌ Failed to populate MongoDB. Falling back to in-memory mode:', error.message);
            isMongoConnected = false;
          }
        }
        resolve(true);
      })
      .on('error', (err) => {
        console.error('❌ CSV parsing error:', err);
        reject(err);
      });
  });
}

// -------------------------------------------------------------
// Data Access Methods (Abstractions supporting Mongoose or Cache)
// -------------------------------------------------------------

export function setConnectionMode(status) {
  isMongoConnected = status;
}

// 1. Get KPI Statistics
export async function getKPIs() {
  if (isMongoConnected) {
    const agg = await Reservation.aggregate([
      {
        $group: {
          _id: null,
          total_bookings: { $sum: 1 },
          total_cancellations: { $sum: '$is_cancelled' },
          total_revenue: {
            $sum: {
              $cond: [{ $eq: ['$is_cancelled', 0] }, '$price', 0]
            }
          },
          avg_adr: { $avg: '$nightPrice' },
          avg_lead_time: { $avg: '$lead_time_days' },
          avg_nights: { $avg: '$nights' }
        }
      }
    ]);
    
    if (agg.length > 0) {
      const res = agg[0];
      return {
        total_bookings: res.total_bookings,
        total_cancellations: res.total_cancellations,
        cancellation_rate: res.total_bookings > 0 ? res.total_cancellations / res.total_bookings : 0,
        total_revenue: res.total_revenue,
        average_adr: res.avg_adr,
        average_lead_time: res.avg_lead_time,
        average_nights: res.avg_nights
      };
    }
  }

  // Fallback DB calculations
  const total = fallbackDb.length;
  const cancellations = fallbackDb.filter(b => b.is_cancelled === 1).length;
  const activeBookings = fallbackDb.filter(b => b.is_cancelled === 0);
  const totalRevenue = activeBookings.reduce((sum, b) => sum + b.price, 0);
  const avgAdr = fallbackDb.reduce((sum, b) => sum + b.nightPrice, 0) / total;
  const avgLeadTime = fallbackDb.reduce((sum, b) => sum + b.lead_time_days, 0) / total;
  const avgNights = fallbackDb.reduce((sum, b) => sum + b.nights, 0) / total;

  return {
    total_bookings: total,
    total_cancellations: cancellations,
    cancellation_rate: total > 0 ? cancellations / total : 0,
    total_revenue: totalRevenue,
    average_adr: avgAdr,
    average_lead_time: avgLeadTime,
    average_nights: avgNights
  };
}

// 2. Get Aggregates for Charts
export async function getAnalytics() {
  if (isMongoConnected) {
    // Room category aggregation
    const roomAgg = await Reservation.aggregate([
      {
        $group: {
          _id: '$roomCategory',
          total_bookings: { $sum: 1 },
          cancellations: { $sum: '$is_cancelled' },
          avg_price: { $avg: '$price' }
        }
      },
      {
        $project: {
          roomCategory: '$_id',
          total_bookings: 1,
          cancellations: 1,
          cancellation_rate: { $divide: ['$cancellations', '$total_bookings'] },
          avg_price: 1,
          _id: 0
        }
      }
    ]);

    // Segment aggregation
    const segmentAgg = await Reservation.aggregate([
      {
        $group: {
          _id: '$segment',
          total_bookings: { $sum: 1 },
          cancellations: { $sum: '$is_cancelled' },
          avg_price: { $avg: '$price' }
        }
      },
      {
        $project: {
          segment_clean: '$_id',
          total_bookings: 1,
          cancellations: 1,
          cancellation_rate: { $divide: ['$cancellations', '$total_bookings'] },
          avg_price: 1,
          _id: 0
        }
      }
    ]);

    // Lead Time Buckets
    const leadTimeAgg = await Reservation.aggregate([
      {
        $project: {
          is_cancelled: 1,
          lead_time_bucket: {
            $cond: [
              { $lte: ['$lead_time_days', 7] }, '0-7 days',
              {
                $cond: [
                  { $lte: ['$lead_time_days', 30] }, '8-30 days',
                  {
                    $cond: [
                      { $lte: ['$lead_time_days', 90] }, '31-90 days', '90+ days'
                    ]
                  }
                ]
              }
            ]
          }
        }
      },
      {
        $group: {
          _id: '$lead_time_bucket',
          total_bookings: { $sum: 1 },
          cancellations: { $sum: '$is_cancelled' }
        }
      },
      {
        $project: {
          lead_time_bucket: '$_id',
          total_bookings: 1,
          cancellations: 1,
          cancellation_rate: { $divide: ['$cancellations', '$total_bookings'] },
          _id: 0
        }
      }
    ]);

    // Monthly trends
    const monthlyAgg = await Reservation.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$checkin' } },
          total_bookings: { $sum: 1 },
          cancellations: { $sum: '$is_cancelled' },
          revenue: {
            $sum: {
              $cond: [{ $eq: ['$is_cancelled', 0] }, '$price', 0]
            }
          }
        }
      },
      {
        $project: {
          month_year: '$_id',
          total_bookings: 1,
          cancellations: 1,
          cancellation_rate: { $divide: ['$cancellations', '$total_bookings'] },
          revenue: 1,
          _id: 0
        }
      },
      { $sort: { month_year: 1 } }
    ]);

    return {
      room_category: roomAgg,
      segment: segmentAgg,
      lead_time: leadTimeAgg,
      monthly_trends: monthlyAgg
    };
  }

  // Local fallback processing (Dynamic mapping from cache)
  const roomMap = {};
  const segmentMap = {};
  const monthlyMap = {};
  const leadTimeMap = {
    "0-7 days": { total_bookings: 0, cancellations: 0 },
    "8-30 days": { total_bookings: 0, cancellations: 0 },
    "31-90 days": { total_bookings: 0, cancellations: 0 },
    "90+ days": { total_bookings: 0, cancellations: 0 }
  };

  for (const b of fallbackDb) {
    // Room category
    if (!roomMap[b.roomCategory]) {
      roomMap[b.roomCategory] = { total_bookings: 0, cancellations: 0, total_price: 0 };
    }
    roomMap[b.roomCategory].total_bookings++;
    roomMap[b.roomCategory].cancellations += b.is_cancelled;
    roomMap[b.roomCategory].total_price += b.price;

    // Segment
    if (!segmentMap[b.segment]) {
      segmentMap[b.segment] = { total_bookings: 0, cancellations: 0, total_price: 0 };
    }
    segmentMap[b.segment].total_bookings++;
    segmentMap[b.segment].cancellations += b.is_cancelled;
    segmentMap[b.segment].total_price += b.price;

    // Lead Time bucket
    let bucket = "90+ days";
    if (b.lead_time_days <= 7) bucket = "0-7 days";
    else if (b.lead_time_days <= 30) bucket = "8-30 days";
    else if (b.lead_time_days <= 90) bucket = "31-90 days";
    leadTimeMap[bucket].total_bookings++;
    leadTimeMap[bucket].cancellations += b.is_cancelled;

    // Month
    const dateObj = new Date(b.checkin);
    const monthYear = isNaN(dateObj.getTime()) ? 'unknown' : `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}`;
    if (monthYear !== 'unknown') {
      if (!monthlyMap[monthYear]) {
        monthlyMap[monthYear] = { total_bookings: 0, cancellations: 0, revenue: 0 };
      }
      monthlyMap[monthYear].total_bookings++;
      monthlyMap[monthYear].cancellations += b.is_cancelled;
      if (b.is_cancelled === 0) {
        monthlyMap[monthYear].revenue += b.price;
      }
    }
  }

  const room_category = Object.entries(roomMap).map(([cat, val]) => ({
    roomCategory: cat,
    total_bookings: val.total_bookings,
    cancellations: val.cancellations,
    cancellation_rate: val.cancellations / val.total_bookings,
    avg_price: val.total_price / val.total_bookings
  }));

  const segment = Object.entries(segmentMap).map(([seg, val]) => ({
    segment_clean: seg,
    total_bookings: val.total_bookings,
    cancellations: val.cancellations,
    cancellation_rate: val.cancellations / val.total_bookings,
    avg_price: val.total_price / val.total_bookings
  }));

  const lead_time = Object.entries(leadTimeMap).map(([bucket, val]) => ({
    lead_time_bucket: bucket,
    total_bookings: val.total_bookings,
    cancellations: val.cancellations,
    cancellation_rate: val.total_bookings > 0 ? val.cancellations / val.total_bookings : 0
  }));

  const monthly_trends = Object.entries(monthlyMap).map(([month, val]) => ({
    month_year: month,
    total_bookings: val.total_bookings,
    cancellations: val.cancellations,
    cancellation_rate: val.cancellations / val.total_bookings,
    revenue: val.revenue
  })).sort((a, b) => a.month_year.localeCompare(b.month_year));

  return { room_category, segment, lead_time, monthly_trends };
}

// 3. Search and Pagination Query
export async function queryReservations({ page = 1, limit = 10, search = '', status = '', category = '', segment = '' }) {
  const skip = (page - 1) * limit;

  if (isMongoConnected) {
    const filter = {};
    if (search) {
      filter.$or = [
        { customer: { $regex: search, $options: 'i' } },
        { bookingId: { $regex: search, $options: 'i' } },
        { bookingNumber: { $regex: search, $options: 'i' } }
      ];
    }
    if (status) {
      if (status === 'CANCELLED') {
        filter.is_cancelled = 1;
      } else if (status === 'CHECKEDOUT') {
        filter.is_cancelled = 0;
      }
    }
    if (category) filter.roomCategory = category;
    if (segment) filter.segment = segment;

    const data = await Reservation.find(filter)
      .sort({ checkin: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Reservation.countDocuments(filter);

    return {
      reservations: data,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    };
  }

  // In-memory Filter Logic
  let filtered = [...fallbackDb];

  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(b => 
      b.customer.toLowerCase().includes(s) || 
      b.bookingId.toLowerCase().includes(s) ||
      b.bookingNumber.toLowerCase().includes(s)
    );
  }

  if (status) {
    if (status === 'CANCELLED') {
      filtered = filtered.filter(b => b.is_cancelled === 1);
    } else if (status === 'CHECKEDOUT') {
      filtered = filtered.filter(b => b.is_cancelled === 0);
    }
  }

  if (category) {
    filtered = filtered.filter(b => b.roomCategory === category);
  }

  if (segment) {
    filtered = filtered.filter(b => b.segment === segment);
  }

  // Sort by check-in date descending
  filtered.sort((a, b) => new Date(b.checkin) - new Date(a.checkin));

  const total = filtered.length;
  const paginated = filtered.slice(skip, skip + limit);

  return {
    reservations: paginated,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    }
  };
}

// 4. CRUD operations
export async function createReservation(data) {
  const bookingId = data.bookingId || `new_${Date.now()}`;
  const is_cancelled = ["CANCELLED", "NOSHOW", "EXPIRED"].includes(data.reservationStatus) ? 1 : 0;
  
  const checkin = new Date(data.checkin);
  const created = new Date(data.created || Date.now());
  const checkout = new Date(data.checkout);
  const lead_time_days = Math.max(0, Math.floor((checkin - created) / (1000 * 60 * 60 * 24)));
  
  const nights = parseInt(data.nights, 10) || 1;
  const price = parseFloat(data.price) || 1576.0;
  const nightPrice = parseFloat((price / nights).toFixed(2));
  const roomCategory = getRoomCategory(data.roomType || 'Standard Room');
  const segment = getCleanSegment(data.segment || 'WalkIn');

  const newRes = {
    bookingId,
    reservationStatus: data.reservationStatus || 'CHECKEDOUT',
    customer: data.customer || 'Guest',
    mainGuest: data.mainGuest || data.customer || 'Guest',
    roomName: data.roomName || '101',
    roomType: data.roomType || 'Standard Room',
    roomCategory,
    adult: parseInt(data.adult, 10) || 2,
    child: parseInt(data.child, 10) || 0,
    bookingNumber: data.bookingNumber || `bk_${Date.now()}`,
    checkin,
    checkout,
    created,
    nights,
    price,
    nightPrice,
    currency: data.currency || 'MAD',
    segment,
    market: data.market || 'DIRECT',
    is_cancelled,
    lead_time_days
  };

  if (isMongoConnected) {
    const resDoc = new Reservation(newRes);
    return await resDoc.save();
  }

  // Insert at the beginning of local cache
  fallbackDb.unshift(newRes);
  return newRes;
}

export async function updateReservation(bookingId, updates) {
  // If status is updated, re-evaluate is_cancelled
  if (updates.reservationStatus) {
    updates.is_cancelled = ["CANCELLED", "NOSHOW", "EXPIRED"].includes(updates.reservationStatus) ? 1 : 0;
  }
  
  if (updates.roomType) {
    updates.roomCategory = getRoomCategory(updates.roomType);
  }
  
  if (updates.segment) {
    updates.segment = getCleanSegment(updates.segment);
  }

  if (updates.checkin || updates.checkout || updates.price || updates.nights) {
    // Recompute computations
    const tempRes = isMongoConnected 
      ? await Reservation.findOne({ bookingId }) 
      : fallbackDb.find(b => b.bookingId === bookingId);
      
    if (tempRes) {
      const checkin = new Date(updates.checkin || tempRes.checkin);
      const created = new Date(updates.created || tempRes.created);
      updates.lead_time_days = Math.max(0, Math.floor((checkin - created) / (1000 * 60 * 60 * 24)));
      
      const nights = parseInt(updates.nights || tempRes.nights, 10);
      const price = parseFloat(updates.price || tempRes.price);
      updates.nightPrice = parseFloat((price / nights).toFixed(2));
    }
  }

  if (isMongoConnected) {
    return await Reservation.findOneAndUpdate({ bookingId }, { $set: updates }, { new: true });
  }

  const index = fallbackDb.findIndex(b => b.bookingId === bookingId);
  if (index !== -1) {
    fallbackDb[index] = { ...fallbackDb[index], ...updates };
    return fallbackDb[index];
  }
  return null;
}

export async function deleteReservation(bookingId) {
  if (isMongoConnected) {
    return await Reservation.findOneAndDelete({ bookingId });
  }

  const index = fallbackDb.findIndex(b => b.bookingId === bookingId);
  if (index !== -1) {
    const deleted = fallbackDb[index];
    fallbackDb.splice(index, 1);
    return deleted;
  }
  return null;
}
